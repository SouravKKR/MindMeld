import asyncio
import json
import os

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generation.PaidDeckActionLog import PaidDeckActionLog
from Globals.Classes.Generation.ReferenceValueSet import ReferenceValueSet
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.WebFetchReasons import WebFetchReasons
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.Workflow import Workflow


class PaidDeckVerification(Workflow):
    """
    Phase 6: fact-checks the generated study material and flashcards for a
    paid-deck run, and writes the flags the review gate blocks on.

    Two independent checks, deliberately not one:

      - A DETERMINISTIC pass (ReferenceValueSet) compares stated physical
        constants and standard values against a curated table, in code. One
        model checking another shares its failure modes; for the handful of
        values a student memorises and reuses all year, a real comparison is
        worth more than a second opinion.

      - An LLM pass checks the things a table cannot: formulae, definitions,
        units, whether the worked examples actually reach their stated answers,
        internal contradictions. Web search is available to it for currency
        checks only — has this value or classification been superseded — never
        to source content.

    Flags are RAISED, never applied. Nothing here rewrites content. The output is
    a verification document that the publish gate reads: while any blocking flag
    is unresolved, the deck cannot be published. That enforcement lives in
    PaidDeckPublishGate on the Dock side — this workflow's job is to produce an
    honest list, including an honest empty one.

    The stage never fails the run. A verification pass that could take down a
    completed generation would create pressure to disable it; instead an
    unreachable verifier is itself recorded as a flag, so the reviewer sees "not
    verified" rather than a silent pass.
    """

    # Entities per LLM call. Verification wants the whole passage in view to
    # recompute a worked example, so batches stay small.
    ENTITIES_PER_REQUEST = 3

    MAXIMUM_CONCURRENT_REQUESTS = 4

    # Guards against a pathological run sending an entire deck to the verifier
    # in one stage. Anything beyond this is reported as unverified rather than
    # silently skipped — a stated gap is credible, a hidden one is not.
    MAXIMUM_VERIFIED_ENTITIES = 400

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__generation_task_id = os.getenv("MAIN_TASK_ID")
        self.__subject_name = (payload.get("subjectName") or "").strip() or "the subject"

    async def __update_progress(self, completion: float):
        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return
        current_task.set_completion(completion)
        await TaskManager.set_task(current_task)

    async def run(self, args = {}):
        verification_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__generation_task_id,
            PersistenceConstants.PAID_DECK_VERIFICATION_FILE_NAME,
        )

        if await Persistence.exists(verification_path):
            print("[PaidDeckVerification] Verification already complete — reusing it (resume).")
            await self.__update_progress(1.0)
            return

        action_log = PaidDeckActionLog(self.__generation_task_id, "PaidDeckVerification")

        entities = await self.__load_generated_entities()

        if not entities:
            print("[PaidDeckVerification] No generated content found to verify.")
            await self.__write_report(verification_path, [], 0, "No generated content was found to verify.")
            await self.__update_progress(1.0)
            return

        b_truncated = len(entities) > PaidDeckVerification.MAXIMUM_VERIFIED_ENTITIES
        verified_entities = entities[: PaidDeckVerification.MAXIMUM_VERIFIED_ENTITIES]

        print(f"[PaidDeckVerification] Verifying {len(verified_entities)} generated item(s)...")
        await self.__update_progress(0.05)

        flags = []

        # ── Deterministic pass ────────────────────────────────────────────────
        flags.extend(await self.__run_reference_value_pass(verified_entities, action_log))
        await self.__update_progress(0.20)

        # ── LLM pass ──────────────────────────────────────────────────────────
        flags.extend(await self.__run_model_pass(verified_entities, action_log))
        await self.__update_progress(0.95)

        if b_truncated:
            skipped_count = len(entities) - len(verified_entities)
            flags.append({
                "category": "COVERAGE",
                "severity": "advisory",
                "source": "STAGE",
                "topicChain": [],
                "quotedText": "",
                "problem": (
                    f"{skipped_count} generated item(s) were not verified — this run exceeded the "
                    f"{PaidDeckVerification.MAXIMUM_VERIFIED_ENTITIES}-item verification ceiling."
                ),
                "correctStatement": "Verify the remaining items before publishing, or split the deck.",
            })

        summary = (
            f"{sum(1 for flag in flags if flag['severity'] == 'blocking')} blocking and "
            f"{sum(1 for flag in flags if flag['severity'] == 'advisory')} advisory flag(s) "
            f"across {len(verified_entities)} item(s)."
        )

        for flag in flags:
            await action_log.record_verification_flag(
                flag_category = flag["category"],
                subject = " > ".join(flag.get("topicChain") or []) or flag.get("quotedText", "")[:80],
                detail = flag["problem"],
                b_blocking = flag["severity"] == "blocking",
            )

        await self.__write_report(verification_path, flags, len(verified_entities), summary)
        await self.__update_progress(1.0)

        print(f"[PaidDeckVerification] Done. {summary}")

    async def __write_report(self, verification_path: str, flags: list, verified_count: int, summary: str) -> None:
        report = {
            "version": 1,
            "verifiedEntityCount": verified_count,
            "blockingFlagCount": sum(1 for flag in flags if flag["severity"] == "blocking"),
            "advisoryFlagCount": sum(1 for flag in flags if flag["severity"] == "advisory"),
            "flags": flags,
            "summary": summary,
        }
        await Persistence.write(verification_path, json.dumps(report, ensure_ascii=False))

    async def __load_generated_entities(self) -> list:
        """
        Reads the staged study materials and flashcards. Both are verified: a
        wrong constant on a flashcard is memorised more reliably than one buried
        in a lesson.
        """
        entities = []

        for directory_name, entity_kind in [
            (PersistenceConstants.STUDY_MATERIALS_DIRECTORY, "studyMaterial"),
            (PersistenceConstants.FLASHCARDS_DIRECTORY, "flashcard"),
        ]:
            prefix = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                self.__generation_task_id,
                directory_name,
            )

            try:
                file_paths = await Persistence.list(prefix)
            except Exception as list_error:
                print(f"[PaidDeckVerification] Could not list {prefix}: {list_error}")
                continue

            for file_path in file_paths:
                if not file_path.endswith(".json"):
                    continue
                try:
                    file_bytes = await Persistence.read(file_path)
                    file_data = json.loads(file_bytes.decode("utf-8"))
                except Exception as read_error:
                    print(f"[PaidDeckVerification] Skipping unreadable {file_path}: {read_error}")
                    continue

                topic_chain = file_data.get("topicChain") or []

                if entity_kind == "studyMaterial":
                    content = file_data.get("content") or ""
                    if content.strip():
                        entities.append({"kind": entity_kind, "topicChain": topic_chain, "text": content})
                else:
                    for card in (file_data.get("cards") or []):
                        combined = f"{card.get('question') or ''}\n{card.get('answer') or ''}".strip()
                        if combined:
                            entities.append({"kind": entity_kind, "topicChain": topic_chain, "text": combined})

        return entities

    async def __run_reference_value_pass(self, entities: list, action_log) -> list:
        """
        The deterministic half. Runs in-process with no model call, so it is fast,
        free, and always available — including when the LLM pass cannot run.
        """
        flags = []

        for entity in entities:
            for mismatch in ReferenceValueSet.check_text(entity["text"]):
                flags.append({
                    "category": "CONSTANT",
                    "severity": "blocking",
                    "source": "REFERENCE_SET",
                    "topicChain": entity["topicChain"],
                    "quotedText": mismatch["sentence"],
                    "problem": (
                        f"{mismatch['name']} is stated as {mismatch['statedNumbers']} but the accepted "
                        f"value is {mismatch['acceptedValue']} {mismatch['unit']}."
                    ),
                    "correctStatement": f"{mismatch['name']} = {mismatch['acceptedValue']} {mismatch['unit']}.",
                })

        await action_log.record_note(
            phase_name = "VERIFICATION",
            outcome = (
                f"Deterministic reference-value check over {len(entities)} item(s): "
                f"{len(flags)} mismatch(es) against the curated constant set."
            ),
        )

        return flags

    async def __run_model_pass(self, entities: list, action_log) -> list:
        batches = [
            entities[batch_start: batch_start + PaidDeckVerification.ENTITIES_PER_REQUEST]
            for batch_start in range(0, len(entities), PaidDeckVerification.ENTITIES_PER_REQUEST)
        ]

        semaphore = asyncio.Semaphore(PaidDeckVerification.MAXIMUM_CONCURRENT_REQUESTS)

        async def verify_batch(batch):
            async with semaphore:
                return await self.__verify_batch(batch, action_log)

        batch_results = await asyncio.gather(*[verify_batch(batch) for batch in batches])

        flags = []
        for batch_flags in batch_results:
            flags.extend(batch_flags)
        return flags

    async def __verify_batch(self, batch: list, action_log) -> list:
        topic_chain = batch[0]["topicChain"] if batch else []

        content_block = "\n\n".join(
            f"--- {entity['kind']} ({' > '.join(entity['topicChain'])}) ---\n{entity['text']}"
            for entity in batch
        )

        model_string, provider_class = ModelPool.PAID_DECK_FACTUAL_VERIFICATION_MODEL
        caller = AutomationCaller(provider_class())

        request = AutomationRequest(
            model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.PAID_DECK_FACTUAL_VERIFICATION_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.PAID_DECK_FACTUAL_VERIFICATION_USER
                        .replace("{subject_name}", self.__subject_name)
                        .replace("{topic_chain}", " > ".join(topic_chain))
                        .replace("{content_block}", content_block),
                    # Currency checks only — the prompt forbids sourcing content.
                    {"enable_search": True},
                ),
            ],
        )

        try:
            response = await caller.call(request, validator = None)
        except Exception as call_error:
            # An unreachable verifier is recorded as an unverified batch, never
            # as a clean one. The reviewer sees a gap instead of a false pass.
            await self.__record(action_log, model_string, None, f"Batch failed: {call_error}", False)
            return [self.__build_unverified_flag(batch, str(call_error))]

        if response is None:
            await self.__record(action_log, model_string, None, "No response from provider.", False)
            return [self.__build_unverified_flag(batch, "No response from provider.")]

        parsed = strip_json_markdown(response.get_output(0).get_data())

        if not isinstance(parsed, dict) or not isinstance(parsed.get("flags"), list):
            await self.__record(action_log, model_string, response, "Unusable response shape.", False)
            return [self.__build_unverified_flag(batch, "Verifier returned an unusable response.")]

        for url in (parsed.get("consultedUrls") or []):
            if isinstance(url, str) and url.strip():
                await action_log.record_web_fetch(
                    phase_name = "VERIFICATION",
                    url = url.strip(),
                    reason_name = WebFetchReasons.CURRENCY_VERIFICATION.name,
                    outcome = "Consulted to check whether a stated value or classification is current.",
                )

        flags = []
        for raw_flag in parsed["flags"]:
            if not isinstance(raw_flag, dict):
                continue
            problem = str(raw_flag.get("problem") or "").strip()
            if not problem:
                continue
            severity = str(raw_flag.get("severity") or "advisory").strip().lower()
            flags.append({
                "category": str(raw_flag.get("category") or "CONTRADICTION").strip().upper(),
                "severity": "blocking" if severity == "blocking" else "advisory",
                "source": "MODEL",
                "topicChain": topic_chain,
                "quotedText": str(raw_flag.get("quotedText") or "").strip()[:400],
                "problem": problem,
                "correctStatement": str(raw_flag.get("correctStatement") or "").strip(),
            })

        await self.__record(
            action_log, model_string, response,
            f"{len(flags)} flag(s) across {len(batch)} item(s).", True,
        )

        return flags

    def __build_unverified_flag(self, batch: list, reason: str) -> dict:
        return {
            "category": "COVERAGE",
            "severity": "advisory",
            "source": "STAGE",
            "topicChain": batch[0]["topicChain"] if batch else [],
            "quotedText": "",
            "problem": f"{len(batch)} item(s) could not be verified: {reason}",
            "correctStatement": "Re-run verification before publishing.",
        }

    async def __record(self, action_log, model_string, response, outcome, b_succeeded):
        await action_log.record_llm_call(
            phase_name = "VERIFICATION",
            model_identifier = model_string,
            prompt_identifier = "PAID_DECK_FACTUAL_VERIFICATION_SYSTEM",
            reasoning_effort = None,
            usage_metadata = response.get_usage_metadata() if response is not None else None,
            outcome = outcome,
            b_succeeded = b_succeeded,
        )
