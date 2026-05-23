import asyncio
import os
import json

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.AutoGeneration.StudyMaterialGenerationSettings import StudyMaterialGenerationSettings
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.SanitizeFilename import sanitize_filename
from Workflows.MapTopicsWithContent.ChunkUtils import extract_leaves
from Workflows.Workflow import Workflow


class GenerateStudyMaterial(Workflow):

    NUM_GROUPS = 5

    def __init__(self, payload={}):
        super().__init__(payload)
        self.__study_material_generation_settings = StudyMaterialGenerationSettings.from_json(payload)
        self.__payload = payload

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
            index = group_weights.index(min(group_weights))
            groups[index].append(entry)
            group_weights[index] += entry["weight"]

        return [group for group in groups if group]

    async def run(self, args={}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        current_task = await TaskManager.get_current_task()

        syllabus_path = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            PersistenceConstants.SYLLABUS_FILE_NAME,
        )

        syllabus_bytes = await Persistence.read(syllabus_path)
        taxonomy = json.loads(syllabus_bytes.decode("utf-8"))

        leaves = extract_leaves(taxonomy)
        await self.__update_progress(0.05)

        topic_entries = []

        for leaf in leaves:
            topic_string = leaf["topic"]
            hierarchy = leaf["path"]

            safe_unit = sanitize_filename(hierarchy[0]) if hierarchy else "Uncategorised"
            safe_topic = sanitize_filename(topic_string)

            file_path = join_path(
                "/",
                PersistenceConstants.TASKS_DIRECTORY,
                main_task_id,
                PersistenceConstants.MAPPED_TOPICS_DIRECTORY,
                safe_unit,
                f"{safe_topic}.json",
            )

            try:
                file_bytes = await Persistence.read(file_path)
                topic_object = json.loads(file_bytes.decode("utf-8"))
                weight = float(topic_object.get("weight", 0.0))
            except Exception:
                continue

            topic_entries.append({
                "path": file_path,
                "weight": weight
            })

        if not topic_entries:
            print("[ERROR] No mapped topic files found.")
            return

        await self.__update_progress(0.15)

        groups = GenerateStudyMaterial.__balance_into_groups(topic_entries, GenerateStudyMaterial.NUM_GROUPS)

        await self.__update_progress(0.25)

        worker_descriptors = []
        worker_task_ids = []

        for group in groups:
            group_paths = [entry["path"] for entry in group]
            group_total_weight = sum(entry["weight"] for entry in group)

            worker_payload = {
                "paths": group_paths,
                "totalWeight": group_total_weight,
                "studyMaterialGenerationSettings": self.__payload
            }

            worker_task = TaskDescriptor(
                type=TaskTypes.STUDY_MATERIAL_GENERATION_WORKER,
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

        print("[GenerateStudyMaterial] Workers done.")