import asyncio
import os
import json

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.AutoGeneration.FlashcardGenerationSettings import FlashcardGenerationSettings
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.AutomationLevels import AutomationLevels
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.MapTopicsWithContent.ChunkUtils import extract_leaves
from Workflows.Workflow import Workflow


class GenerateFlashcards(Workflow):

    NUM_GROUPS = 5

    def __init__(self, payload={}):
        super().__init__(payload)
        self.__flashcard_generation_settings: FlashcardGenerationSettings = FlashcardGenerationSettings.from_json(payload)
        self.__payload = payload
        self.__prepare_images_task_id = payload.get("prepareImagesTaskId")

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    @staticmethod
    def __balance_into_groups(topic_entries: list[dict], num_groups: int) -> list[list[dict]]:
        sorted_entries = sorted(topic_entries, key=lambda entry: entry["weight"], reverse=True)

        groups = [[] for _ in range(num_groups)]
        group_weights = [0.0] * num_groups

        for entry in sorted_entries:
            lightest_group_index = group_weights.index(min(group_weights))
            groups[lightest_group_index].append(entry)
            group_weights[lightest_group_index] += entry["weight"]

        return [group for group in groups if group]

    @staticmethod
    def __normalize_weights(weights: dict) -> dict:
        total = sum(weights.values())
        if total <= 0:
            return weights
        return {key: value / total for key, value in weights.items()}

    @staticmethod
    def __blend_weights(weights_a: dict, weights_b: dict) -> dict:
        all_keys = set(weights_a.keys()) | set(weights_b.keys())
        normalized_a = GenerateFlashcards.__normalize_weights(weights_a)
        normalized_b = GenerateFlashcards.__normalize_weights(weights_b)
        return {key: (normalized_a.get(key, 0) + normalized_b.get(key, 0)) / 2 for key in all_keys}

    async def __resolve_exam_type_weights(self, exam_name: str) -> dict | None:
        available_question_types = list(self.__flashcard_generation_settings.get_question_types_with_weights().keys())
        question_types_string = "\n".join(f"- {question_type}" for question_type in available_question_types)

        user_prompt = (
            PromptPool.EXAM_QUESTION_TYPE_GROUNDING_USER
            .replace("{exam_name}", exam_name)
            .replace("{question_types}", question_types_string)
        )

        exam_model_string, exam_provider_class = ModelPool.EXAM_QUESTION_TYPE_DETERMINER_MODEL
        provider = exam_provider_class()
        caller = AutomationCaller(provider)

        request = AutomationRequest(
            exam_model_string,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.EXAM_QUESTION_TYPE_GROUNDING_SYSTEM),
                AutomationContent(AutomationContentTypes.TEXT, user_prompt),
            ]
        )

        def validator(response):
            try:
                data = response.get_output().get_data()
                parsed = strip_json_markdown(data) if isinstance(data, str) else data
                if not isinstance(parsed, dict) or len(parsed) == 0:
                    return False
                return all(isinstance(value, (int, float)) for value in parsed.values())
            except Exception:
                return False

        response = await caller.call(request, validator)

        if response is None:
            print(f"[WARN] Exam type grounding call failed for '{exam_name}' — falling back to default behaviour.")
            return None

        try:
            data = response.get_output().get_data()
            return strip_json_markdown(data) if isinstance(data, str) else data
        except Exception:
            return None

    async def run(self, args={}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        current_task = await TaskManager.get_current_task()

        # ── 1. Load the syllabus to get the leaf topic structure ───────────────
        syllabus_path = join_path("/", PersistenceConstants.TASKS_DIRECTORY, main_task_id, PersistenceConstants.SYLLABUS_FILE_NAME)
        syllabus_bytes = await Persistence.read(syllabus_path)
        taxonomy = json.loads(syllabus_bytes.decode("utf-8"))

        leaves = extract_leaves(taxonomy)
        print(f"Loaded {len(leaves)} leaf topics from syllabus.")
        await self.__update_progress(0.05)

        # ── 2. Reconstruct mapped topic file paths and read weights ────────────
        topic_entries = []

        for leaf in leaves:
            topicStr = leaf["topic"]
            hierarchy = leaf["path"]
            safeUnit = sanitize_filename(hierarchy[0]) if hierarchy else "Uncategorised"
            safeTopic = sanitize_filename(topicStr)

            file_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.MAPPED_TOPICS_DIRECTORY,
                safeUnit,
                f"{safeTopic}.json",
            )

            try:
                file_bytes = await Persistence.read(file_path)
                topic_object = json.loads(file_bytes.decode("utf-8"))
                weight = float(topic_object.get("weight", 0.0))
            except Exception:
                continue

            topic_entries.append({"path": file_path, "weight": weight})

        print(f"{len(topic_entries)} mapped topic files found.")
        await self.__update_progress(0.15)

        if not topic_entries:
            print("[ERROR] No mapped topic files found — cannot generate flashcards.")
            return

        # ── 3. Resolve exam-aware question type weights (once, before grouping) ─
        resolved_type_weights = None

        exam_name = self.__flashcard_generation_settings.get_exam_name()
        question_types_method = self.__flashcard_generation_settings.get_question_types_method()

        if exam_name:
            llm_weights = await self.__resolve_exam_type_weights(exam_name)

            if llm_weights is not None:
                if question_types_method == AutomationLevels.MANUAL:
                    user_weights = {
                        key: value
                        for key, value in self.__flashcard_generation_settings.get_question_types_with_weights().items()
                        if value > 0
                    }
                    resolved_type_weights = GenerateFlashcards.__blend_weights(llm_weights, user_weights)
                else:
                    resolved_type_weights = llm_weights

        await self.__update_progress(0.20)

        # ── 4. Balance topics into groups ──────────────────────────────────────
        groups = GenerateFlashcards.__balance_into_groups(topic_entries, GenerateFlashcards.NUM_GROUPS)

        print(f"Divided into {len(groups)} group(s):")
        for index, group in enumerate(groups):
            group_weight = sum(entry["weight"] for entry in group)
            print(f"  Group {index + 1}: {len(group)} topic(s), total weight = {group_weight:.4f}")

        await self.__update_progress(0.25)

        # ── 5. Create worker tasks, save to Redis, run internally ─────────────
        worker_descriptors = []
        worker_task_ids = []

        for group in groups:
            group_paths = [entry["path"] for entry in group]
            group_total_weight = sum(entry["weight"] for entry in group)

            worker_payload = {
                "paths": group_paths,
                "totalWeight": group_total_weight,
                "flashcardGenerationSettings": self.__payload,
            }

            if resolved_type_weights is not None:
                worker_payload["resolvedTypeWeights"] = resolved_type_weights

            worker_task = TaskDescriptor(
                type=TaskTypes.FLASHCARD_GENERATION_WORKER,
                execution_target=TaskExecutionTargets.LOCAL,
                payload=worker_payload,
                next_task_ids=[],
                parent_task_id=current_task.get_id()
            )

            await TaskManager.set_task(worker_task)
            worker_descriptors.append(worker_task)
            worker_task_ids.append(worker_task.get_id())

        # Set workers as nextTaskIds now so the progress tree is visible during execution
        current_task.set_next_task_ids(worker_task_ids)
        await TaskManager.set_task(current_task)
        await self.__update_progress(0.30)

        print(f"Running {len(worker_descriptors)} worker task(s) internally...")

        main_task = await TaskManager.get_task(main_task_id)
        await asyncio.gather(*[
            TaskManager.execute(worker, main_task=main_task, parent_task_id=current_task.get_id())
            for worker in worker_descriptors
        ])

        # Use get_current_task() so we mutate the same object Main.py's finally block holds.
        # get_task() creates a new object; Main.py would then overwrite Redis with the old
        # nextTaskIds when it saves task_descriptor in its finally block.
        current_task = await TaskManager.get_current_task()
        next_ids = [self.__prepare_images_task_id] if self.__prepare_images_task_id else []
        current_task.set_next_task_ids(next_ids)
        await TaskManager.set_task(current_task)

        print(f"[GenerateFlashcards] Workers done. Chaining to: {next_ids}")