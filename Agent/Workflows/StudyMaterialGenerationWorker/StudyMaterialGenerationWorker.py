import os
import json
from datetime import datetime, timezone

from Workflows.Workflow import Workflow
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent
from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.BatchSubmitter import BatchSubmitter
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Compliance.SourceSimilarityScorer import SourceSimilarityScorer
from Globals.Classes.StudyMaterial.StudyMaterialDetailDirectives import StudyMaterialDetailDirectives
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Classes.Task.AutoGeneration.StudyMaterialGenerationSettings import StudyMaterialGenerationSettings
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.StudyMaterialDetailLevels import StudyMaterialDetailLevels
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.SanitizeHtmlResponse import sanitize_html_response


class StudyMaterialGenerationWorker(Workflow):

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__paths = payload["paths"]
        self.__total_weight = payload["totalWeight"]
        self.__settings = StudyMaterialGenerationSettings.from_json(payload["studyMaterialGenerationSettings"])

    async def run(self, args = {}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        parent_task_id = os.getenv("PARENT_TASK_ID")

        model_string, provider_class = ModelPool.STUDY_MATERIAL_MODEL

        subject_name = (self.__settings.get_subject_name() or "").strip()
        exam_name = (self.__settings.get_exam_name() or "").strip()
        additional_instructions = (self.__settings.get_additional_instructions() or "").strip()

        subject_label = subject_name if subject_name else "Not specified"
        exam_context = f"This is being prepared for the {exam_name} exam." if exam_name else "No specific exam target."
        additional_instructions_block = (
            f"\nAdditional instructions: {additional_instructions}" if additional_instructions else ""
        )

        # Always normalise to at least one tier so an empty/legacy setting
        # produces a STANDARD-tier material rather than silently dropping the
        # generation.
        selected_detail_levels = self.__settings.get_detail_levels() or [int(StudyMaterialDetailLevels.STANDARD)]

        # ── 1. Build one request per (topic, detail_level) ────────────────────
        loaded_jobs = []

        for path in self.__paths:
            content_bytes = await Persistence.read(path)
            raw = json.loads(content_bytes.decode("utf-8"))

            topic_chain = raw["topicChain"]
            source_pages = raw.get("sourcePages", [])
            content = "\n\n".join(raw["chunks"])
            content = TokenSafeContent.cap_content_for_prompt(
                content,
                label = f"study material topic content ({' -> '.join(topic_chain)})",
            )
            topic_weight = float(raw.get("weight", 0.0))

            # Split the topic's progress weight across its detail-level
            # passes so the bar advances uniformly regardless of how many
            # tiers the user picked.
            per_level_weight = topic_weight / max(1, len(selected_detail_levels))

            for detail_level in selected_detail_levels:
                directive = StudyMaterialDetailDirectives.get_directive(detail_level)
                level_name = StudyMaterialDetailLevels(detail_level).name
                user_prompt = (
                    PromptPool.STUDY_MATERIAL_GENERATION_USER
                    .replace("{content}", content)
                    .replace("{topic_chain}", " -> ".join(topic_chain))
                    .replace("{subject}", subject_label)
                    .replace("{exam_context}", exam_context)
                    .replace("{detail_level_instruction}", directive)
                    .replace("{additional_instructions_block}", additional_instructions_block)
                )

                request = AutomationRequest(
                    model_string,
                    [
                        # The shared expression rules lead so every generation
                        # prompt inherits the same copyright/accuracy posture.
                        # The provider joins multiple SYSTEM parts with a newline.
                        AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.SOURCE_EXPRESSION_RULES),
                        AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.STUDY_MATERIAL_GENERATION_SYSTEM),
                        AutomationContent(AutomationContentTypes.TEXT, user_prompt, {"response_as_text": True}),
                    ]
                )

                safe_unit = sanitize_filename(topic_chain[0]) if topic_chain else "Uncategorised"
                safe_topic = sanitize_filename(topic_chain[-1]) if topic_chain else "Unknown"
                safe_level = sanitize_filename(level_name)
                output_path = join_path(
                    "/",
                    PersistenceConstants.TASKS_DIRECTORY,
                    main_task_id,
                    PersistenceConstants.STUDY_MATERIALS_DIRECTORY,
                    safe_unit,
                    f"{safe_topic}__{safe_level}.json",
                )

                loaded_jobs.append({
                    "topic_chain": topic_chain,
                    "source_content": content,
                    "source_pages": source_pages,
                    "detail_level": int(detail_level),
                    "level_name": level_name,
                    "weight": per_level_weight,
                    "request": request,
                    "key": f"job-{len(loaded_jobs)}",
                    "output_path": output_path,
                })

        if not loaded_jobs:
            return

        # ── 2. Checkpoint-resume: skip jobs already generated in a prior run ──
        # The per-topic output file in GCS is the checkpoint — if it exists the
        # work is done, so grant its full weight and don't regenerate. This is
        # what lets a resumed run continue from midway instead of re-running.
        jobs_to_generate = []
        for job in loaded_jobs:
            if await Persistence.exists(job["output_path"]):
                print(f"[StudyMaterialGenerationWorker] Reusing existing output for '{' -> '.join(job['topic_chain'])}' ({job['level_name']}) — skipping generation.")
                await TaskManager.increment_completion(parent_task_id, job["weight"])
            else:
                jobs_to_generate.append(job)

        if not jobs_to_generate:
            print("[StudyMaterialGenerationWorker] All study material already generated — nothing to do.")
            return

        # ── 3. Enqueue the remaining requests into a single-model BatchSubmitter
        main_task = await TaskManager.get_task(main_task_id)

        submitter = BatchSubmitter(model_string, main_task = main_task)
        for job in jobs_to_generate:
            submitter.enqueue(job["key"], job["request"])

        caller = AutomationCaller(provider_class())

        # Grant the submit-time share of each job's weight up front so the parent
        # bar visibly advances when the batch is dispatched, not only minutes
        # later when Gemini returns. The remaining share lands per result below.
        for job in jobs_to_generate:
            await TaskManager.increment_completion(parent_task_id, BatchSubmitter.SUBMIT_PROGRESS_SHARE * job["weight"])

        # ── 4. Submit batch + collect (with live-API fallback per missing key)
        batch_results = await caller.call_batch(
            submitter,
            live_fallback_caller = caller,
            validators           = None,
        )

        # ── 5. Persist per (topic, detail_level) + increment completion ───────
        for job in jobs_to_generate:
            response = batch_results.get(job["key"])
            if response is None:
                # Still grant the result-share so the job's full weight is
                # accounted for even when it produced nothing — otherwise the
                # parent bar lags low for every missing response (the submit
                # share alone was already granted above).
                await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * job["weight"])
                continue

            data = response.get_output().get_data()
            parsed = sanitize_html_response(str(data))

            # Observability only — never gates the generation. Reports how much
            # of the generated PROSE overlaps the source chunks it was grounded
            # on, with formulae, notation, code and tables masked out first so
            # the content that must be reproduced verbatim is not counted
            # against it. Provides the evidence needed to set a threshold before
            # any enforcement is considered.
            gate_result = SourceSimilarityScorer.evaluate_gate(
                f"study-material topic='{' -> '.join(job['topic_chain'])}' level={job['level_name']}",
                parsed,
                [job["source_content"]],
            )

            # Enforcement is opt-in and off by default (see SourceSimilarityScorer).
            # Until it is switched on with a calibrated threshold, this branch is
            # never taken and the score is telemetry only. Dropping the material
            # is the safe failure mode: a missing section is recoverable, shipping
            # a substantially-copied one is not.
            if gate_result["bShouldReject"]:
                print(
                    f"[StudyMaterialGenerationWorker] Rejected '{' -> '.join(job['topic_chain'])}' "
                    f"({job['level_name']}) — source containment {gate_result['containment']:.4f} "
                    f"exceeds threshold {gate_result['threshold']:.4f}."
                )
                await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * job["weight"])
                continue

            output = {
                "topicChain": job["topic_chain"],
                "content": parsed,
                "sourcePages": job["source_pages"],
                "detailLevel": job["detail_level"],
                "generatedAt": datetime.now(timezone.utc).isoformat(),
            }

            await Persistence.write(job["output_path"], json.dumps(output, ensure_ascii=False))

            await TaskManager.increment_completion(parent_task_id, (1.0 - BatchSubmitter.SUBMIT_PROGRESS_SHARE) * job["weight"])
