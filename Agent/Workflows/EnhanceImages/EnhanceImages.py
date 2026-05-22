import json
import os

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Utility.JoinPath import join_path

from Workflows.EnhanceImages.AssetEnhancer import AssetEnhancer
from Workflows.EnhanceImages.HtmlImageRewriter import HtmlImageRewriter
from Workflows.Workflow import Workflow


class EnhanceImages(Workflow):
    """
    Copyright-safe / brand-consistent post-processing of base64 images
    previously injected into the generated flashcard and study-material
    HTML by PrepareImages.

    Invariants:
      * The original image bytes uploaded to GCS (`figures/<phash>.png`)
        and the `figures` MongoDB collection are NOT touched -- they keep
        the source material verbatim. This workflow only rewrites the
        embedded `<figure>` blocks inside the per-task flashcard /
        study-material JSON files, which `moveToDatabase` later persists
        into the `cards` and `studyMaterials` collections.
      * Per-image failures (Gemini error, malformed extraction, empty
        image payload, markdown render failure) are propagated as task
        failures. The user explicitly chose strict error semantics over
        silent fallback to the original image.
    """

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__generation_task_id = os.getenv("MAIN_TASK_ID")
        self.__generate_study_materials = payload.get("generateStudyMaterials", False)
        self.__generate_flashcards = payload.get("generateFlashcards", False)

    async def run(self, args = {}):
        if not self.__generation_task_id:
            print("[EnhanceImages] MAIN_TASK_ID not set in environment -- nothing to do.")
            return

        await self.__update_progress(0.05)

        study_material_files = await self.__load_study_material_files()
        flashcard_files = await self.__load_flashcard_files()

        if not study_material_files and not flashcard_files:
            print("[EnhanceImages] No generated content files found -- nothing to enhance.")
            return

        await self.__update_progress(0.15)

        asset_enhancer = AssetEnhancer()

        total_figure_count = self.__count_total_figures(study_material_files, flashcard_files)
        if total_figure_count == 0:
            print("[EnhanceImages] No embedded <figure> blocks found in any content file -- skipping.")
            await self.__update_progress(1.0)
            return

        print(
            f"[EnhanceImages] Enhancing {total_figure_count} embedded figure(s) across "
            f"{len(study_material_files)} study material file(s) and "
            f"{len(flashcard_files)} flashcard file(s)."
        )

        processed_figure_count = 0

        for study_material_file in study_material_files:
            processed_figure_count = await self.__enhance_figures_in_study_material(
                study_material_file,
                asset_enhancer,
                processed_figure_count,
                total_figure_count,
            )

        for flashcard_file in flashcard_files:
            processed_figure_count = await self.__enhance_figures_in_flashcard_file(
                flashcard_file,
                asset_enhancer,
                processed_figure_count,
                total_figure_count,
            )

        # Persist the modified JSON files back -- matches PrepareImages' write
        # pattern (pop the synthetic _filePath key, then Persistence.write).
        await self.__write_modified_files(study_material_files)
        await self.__write_modified_files(flashcard_files)

        print(
            f"[EnhanceImages] Done. Enhanced {processed_figure_count} figure(s) across all content files."
        )
        await self.__update_progress(1.0)

    async def __update_progress(self, completion: float):
        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return
        current_task.set_completion(completion)
        await TaskManager.set_task(current_task)

    async def __load_study_material_files(self) -> list[dict]:
        if not self.__generate_study_materials:
            return []

        study_material_prefix = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__generation_task_id,
            PersistenceConstants.STUDY_MATERIALS_DIRECTORY,
        )
        return await self.__load_json_files_from_prefix(study_material_prefix)

    async def __load_flashcard_files(self) -> list[dict]:
        if not self.__generate_flashcards:
            return []

        flashcard_prefix = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__generation_task_id,
            PersistenceConstants.FLASHCARDS_DIRECTORY,
        )
        return await self.__load_json_files_from_prefix(flashcard_prefix)

    async def __load_json_files_from_prefix(self, persistence_prefix: str) -> list[dict]:
        file_paths = await Persistence.list(persistence_prefix)
        loaded_files: list[dict] = []

        for file_path in file_paths:
            if not file_path.endswith(".json"):
                continue
            file_bytes = await Persistence.read(file_path)
            file_data = json.loads(file_bytes.decode("utf-8"))
            file_data["_filePath"] = file_path
            loaded_files.append(file_data)

        return loaded_files

    def __count_total_figures(
        self,
        study_material_files: list[dict],
        flashcard_files: list[dict],
    ) -> int:
        running_total = 0

        for study_material_file in study_material_files:
            content_html = study_material_file.get("content") or ""
            running_total += len(HtmlImageRewriter.find_extracted_figures(content_html))

        for flashcard_file in flashcard_files:
            for card in flashcard_file.get("cards") or []:
                for field_name in ("question", "answer"):
                    field_html = card.get(field_name) or ""
                    running_total += len(HtmlImageRewriter.find_extracted_figures(field_html))

        return running_total

    async def __enhance_figures_in_study_material(
        self,
        study_material_file: dict,
        asset_enhancer: AssetEnhancer,
        processed_figure_count: int,
        total_figure_count: int,
    ) -> int:
        content_html = study_material_file.get("content") or ""
        new_content_html, processed_figure_count = await self.__enhance_html_field(
            content_html,
            asset_enhancer,
            processed_figure_count,
            total_figure_count,
        )
        study_material_file["content"] = new_content_html
        return processed_figure_count

    async def __enhance_figures_in_flashcard_file(
        self,
        flashcard_file: dict,
        asset_enhancer: AssetEnhancer,
        processed_figure_count: int,
        total_figure_count: int,
    ) -> int:
        cards = flashcard_file.get("cards") or []

        for card in cards:
            for field_name in ("question", "answer"):
                field_html = card.get(field_name) or ""
                new_field_html, processed_figure_count = await self.__enhance_html_field(
                    field_html,
                    asset_enhancer,
                    processed_figure_count,
                    total_figure_count,
                )
                card[field_name] = new_field_html

        return processed_figure_count

    async def __enhance_html_field(
        self,
        html_content: str,
        asset_enhancer: AssetEnhancer,
        processed_figure_count: int,
        total_figure_count: int,
    ) -> tuple[str, int]:
        figure_matches = HtmlImageRewriter.find_extracted_figures(html_content)
        if not figure_matches:
            return html_content, processed_figure_count

        replacements: list[dict] = []

        for figure_match in figure_matches:
            enhancement_result = await asset_enhancer.enhance(figure_match["imageBytes"])

            if enhancement_result["kind"] == "DIAGRAM":
                new_figure_html = HtmlImageRewriter.build_diagram_replacement_html(
                    enhancement_result["imageBytes"],
                    figure_match["figcaptionHtml"],
                )
            elif enhancement_result["kind"] == "TEXT_DATA":
                new_figure_html = HtmlImageRewriter.build_text_data_replacement_html(
                    enhancement_result["markdown"],
                )
            else:
                raise RuntimeError(
                    f"EnhanceImages: AssetEnhancer returned unrecognized kind "
                    f"'{enhancement_result.get('kind')}'."
                )

            replacements.append({
                "start": figure_match["start"],
                "end": figure_match["end"],
                "newHtml": new_figure_html,
            })

            processed_figure_count += 1
            if total_figure_count > 0:
                # Reserve the [0.15, 0.95] band for per-figure work so the
                # bookkeeping ticks at start/end remain visible.
                fraction_done = processed_figure_count / total_figure_count
                await self.__update_progress(0.15 + 0.80 * fraction_done)

        return HtmlImageRewriter.apply_replacements(html_content, replacements), processed_figure_count

    async def __write_modified_files(self, loaded_files: list[dict]):
        for loaded_file in loaded_files:
            if "_filePath" not in loaded_file:
                continue
            original_file_path = loaded_file.pop("_filePath")
            await Persistence.write(
                original_file_path,
                json.dumps(loaded_file, ensure_ascii = False),
            )
