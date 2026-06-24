import json
import os

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Utility.JoinPath import join_path

from Workflows.EnhanceImages.DiagramImageEnhancer import DiagramImageEnhancer
from Workflows.PrepareImages.HtmlInjector import HtmlInjector
from Workflows.Workflow import Workflow


# Sidecar PrepareImages writes when EnhanceImages is enabled. Lives at
# Tasks/{mainTaskId}/figure_assignments.json. Names match the constant
# PrepareImages writes to -- keep them in sync if either side moves.
_FIGURE_ASSIGNMENTS_SIDECAR_FILENAME = "figure_assignments.json"


class EnhanceImages(Workflow):
    """
    Copyright-safe image pass that runs AFTER
    PrepareImages and BEFORE moveToDatabase. Reads the per-task figure
    assignments sidecar emitted by PrepareImages, fetches each figure's
    bytes from GCS, enhances them via DiagramImageEnhancer (Gemini describes
    the figure, GPT-Image regenerates it as a copyright-clean new image), and
    injects the result directly into the per-task flashcard / study-material
    JSON files.

    Sidecar-driven design rationale:
      * PrepareImages skipping injection when this workflow is in the
        pipeline means the per-task JSONs never carry the source
        artwork as intermediate state. If EnhanceImages crashes the
        upstream JSONs are still pristine and a retry can re-enhance
        cleanly.
      * The whole pipeline aborts on EnhanceImages failure (Generate.js
        re-throws so moveToDatabase doesn't run), so a half-enhanced
        deck cannot leak un-enhanced source artwork into the user's
        library.

    Invariants:
      * PrepareImages stages every referenced figure's bytes under
        Tasks/{taskId}/figures_scratch/<phash>.png and points each
        sidecar assignment at that path; this workflow reads from there
        and does NOT touch the global figures/<phash>.png objects. The
        global path is a long-lived dedup cache that can outlive an
        individual generation task -- reading from it would 404 if the
        bucket has been reset between extraction and enhancement.
        This workflow only writes the per-task flashcard / study-
        material JSONs that moveToDatabase later persists into the cards
        and studyMaterials collections.
      * Hard errors (missing gcsImagePath, unreadable figure bytes, or an
        unrecognized enhancer kind) propagate as task failures so a broken
        deck is never persisted. A FAILED enhancement (Gemini describe error,
        GPT-Image generation error, missing OPENAI_API_KEY, or empty image
        payload) instead returns DIAGRAM_FALLBACK_ORIGINAL and embeds the
        original extracted figure, so the figure still appears and any
        "see Figure N" reference keeps resolving.
    """

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__generation_task_id = os.getenv("MAIN_TASK_ID")

    async def run(self, args = {}):
        if not self.__generation_task_id:
            print("[EnhanceImages] MAIN_TASK_ID not set in environment -- nothing to do.")
            return

        await self.__update_progress(0.05)

        sidecar_path = self.__compute_sidecar_path()
        sidecar_document = await self.__load_sidecar(sidecar_path)
        if sidecar_document is None:
            print(
                f"[EnhanceImages] No assignments sidecar at {sidecar_path} -- "
                f"PrepareImages either skipped or ran in inline mode. Nothing to enhance."
            )
            await self.__update_progress(1.0)
            return

        assignments = sidecar_document.get("assignments") or []
        if not assignments:
            print("[EnhanceImages] Sidecar has zero assignments -- nothing to enhance.")
            await self.__update_progress(1.0)
            return

        print(f"[EnhanceImages] Enhancing {len(assignments)} assignment(s) from sidecar.")

        # Group assignments by their target file so we load + write each
        # JSON exactly once. Per-file lists are sorted by block index
        # descending so we splice from the back -- preserving the
        # earlier-block byte offsets while inserting later-block figures
        # (the same trick PrepareImages.HtmlInjector relies on).
        assignments_by_file_path: dict[str, list] = {}
        for assignment in assignments:
            file_path = assignment.get("filePath")
            if not file_path:
                continue
            assignments_by_file_path.setdefault(file_path, []).append(assignment)

        await self.__update_progress(0.10)

        asset_enhancer = DiagramImageEnhancer()
        total_assignment_count = len(assignments)
        completed_assignment_count = 0

        for file_path, file_assignments in assignments_by_file_path.items():
            file_document = await self.__load_json_file(file_path)
            if file_document is None:
                # PrepareImages flagged this file path but we can't read
                # it back -- treat as a hard error so moveToDatabase
                # doesn't persist a partially-enhanced deck.
                raise RuntimeError(
                    f"EnhanceImages: assignment references unreadable file '{file_path}'."
                )

            await self.__enhance_assignments_in_file(
                file_document,
                file_assignments,
                asset_enhancer,
            )

            await Persistence.write(
                file_path,
                json.dumps(file_document, ensure_ascii = False),
            )

            completed_assignment_count += len(file_assignments)
            if total_assignment_count > 0:
                fraction_done = completed_assignment_count / total_assignment_count
                await self.__update_progress(0.10 + 0.85 * fraction_done)

        print(
            f"[EnhanceImages] Done. Enhanced {total_assignment_count} figure(s) across "
            f"{len(assignments_by_file_path)} file(s)."
        )
        await self.__update_progress(1.0)

    async def __update_progress(self, completion: float):
        current_task = await TaskManager.get_current_task()
        if current_task is None:
            return
        current_task.set_completion(completion)
        await TaskManager.set_task(current_task)

    def __compute_sidecar_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__generation_task_id,
            _FIGURE_ASSIGNMENTS_SIDECAR_FILENAME,
        )

    async def __load_sidecar(self, sidecar_path: str) -> dict | None:
        try:
            sidecar_bytes = await Persistence.read(sidecar_path)
        except Exception as read_error:
            print(f"[EnhanceImages] Could not read sidecar at {sidecar_path}: {read_error}")
            return None

        try:
            return json.loads(sidecar_bytes.decode("utf-8"))
        except Exception as parse_error:
            raise RuntimeError(
                f"EnhanceImages: sidecar at {sidecar_path} is not valid JSON: {parse_error}"
            )

    async def __load_json_file(self, file_path: str) -> dict | None:
        try:
            file_bytes = await Persistence.read(file_path)
            return json.loads(file_bytes.decode("utf-8"))
        except Exception as load_error:
            print(f"[EnhanceImages] Could not load file {file_path}: {load_error}")
            return None

    async def __enhance_assignments_in_file(
        self,
        file_document: dict,
        file_assignments: list,
        asset_enhancer: DiagramImageEnhancer,
    ):
        """
        Splices every assignment for a single content file into its HTML.
        Study materials carry a single "content" field; flashcards carry a
        list of cards each with question/answer fields. We dispatch on
        the assignment's `fileType` rather than peeking at the document
        shape so an unexpected payload fails loudly.
        """
        # Inserting figures at later block positions FIRST keeps earlier-block
        # byte offsets valid for the subsequent inserts in the same field.
        # We bucket by (cardIndex, fieldName) for flashcards because each
        # field is its own independent HTML blob; study-material content
        # is a single field so all assignments share the same bucket.
        for assignment in sorted(file_assignments, key = lambda a: a.get("blockIndex", 0), reverse = True):
            file_type = assignment.get("fileType")
            if file_type == "studyMaterial":
                await self.__inject_into_study_material(file_document, assignment, asset_enhancer)
            elif file_type == "flashcard":
                await self.__inject_into_flashcard(file_document, assignment, asset_enhancer)
            else:
                raise RuntimeError(
                    f"EnhanceImages: unrecognized assignment fileType '{file_type}'."
                )

    async def __inject_into_study_material(
        self,
        study_material_document: dict,
        assignment: dict,
        asset_enhancer: DiagramImageEnhancer,
    ):
        content_html = study_material_document.get("content") or ""
        block_elements = HtmlInjector.extract_block_elements(content_html)
        if not block_elements:
            return

        target_block_index  = min(assignment.get("blockIndex", 0), len(block_elements) - 1)
        insertion_position  = block_elements[target_block_index]["end"]

        replacement_html = await self.__build_enhanced_html(assignment, asset_enhancer)
        study_material_document["content"] = HtmlInjector.inject_figure_after_block(
            content_html, insertion_position, replacement_html
        )

    async def __inject_into_flashcard(
        self,
        flashcard_document: dict,
        assignment: dict,
        asset_enhancer: DiagramImageEnhancer,
    ):
        cards = flashcard_document.get("cards") or []
        card_index = assignment.get("cardIndex")
        if not isinstance(card_index, int) or card_index < 0 or card_index >= len(cards):
            return

        card = cards[card_index]
        field_name = assignment.get("fieldName")
        if field_name not in ("question", "answer"):
            return

        field_html = card.get(field_name) or ""
        block_elements = HtmlInjector.extract_block_elements(field_html)
        if not block_elements:
            return

        target_block_index = min(assignment.get("blockIndex", 0), len(block_elements) - 1)
        insertion_position = block_elements[target_block_index]["end"]

        replacement_html = await self.__build_enhanced_html(assignment, asset_enhancer)
        card[field_name] = HtmlInjector.inject_figure_after_block(
            field_html, insertion_position, replacement_html
        )

    async def __build_enhanced_html(
        self,
        assignment: dict,
        asset_enhancer: DiagramImageEnhancer,
    ) -> str:
        """
        Fetches the original figure bytes from the GCS path embedded in
        the assignment, runs DiagramImageEnhancer, and returns the final HTML
        snippet to splice into the surrounding content. The enhancer returns a
        regenerated PNG (DIAGRAM_IMAGE_PNG) or, when describe / generate fails,
        DIAGRAM_FALLBACK_ORIGINAL; both embed through build_figure_html so the
        markup matches inline-mode injection exactly.
        """
        gcs_image_path = assignment.get("gcsImagePath")
        if not gcs_image_path:
            raise RuntimeError("EnhanceImages: assignment has no gcsImagePath.")

        try:
            original_image_bytes = await Persistence.read(gcs_image_path)
        except Exception as fetch_error:
            raise RuntimeError(
                f"EnhanceImages: could not fetch original figure bytes at "
                f"{gcs_image_path}: {fetch_error}"
            )

        enhancement_result = await asset_enhancer.enhance(original_image_bytes)

        if enhancement_result["kind"] == "DIAGRAM_IMAGE_PNG":
            # GPT-Image generated a fresh PNG from the Gemini description.
            # Embed it the same way as an original figure -- it is already a
            # copyright-clean new expression.
            return HtmlInjector.build_figure_html(
                enhancement_result["image_bytes"],
                assignment.get("captionText") or "",
                assignment.get("figureNumber") or 0,
                source_url      = assignment.get("sourceUrl"),
                source_page_url = assignment.get("sourcePageUrl"),
                bounding_box    = assignment.get("boundingBoxCoordinates"),
            )

        if enhancement_result["kind"] == "DIAGRAM_FALLBACK_ORIGINAL":
            # The enhancement call failed (transient API error, refusal, or no
            # usable output). Embed the ORIGINAL extracted figure so the diagram
            # still appears and any "see Figure N" reference keeps resolving.
            return HtmlInjector.build_figure_html(
                original_image_bytes,
                assignment.get("captionText") or "",
                assignment.get("figureNumber") or 0,
                source_url      = assignment.get("sourceUrl"),
                source_page_url = assignment.get("sourcePageUrl"),
                bounding_box    = assignment.get("boundingBoxCoordinates"),
            )

        raise RuntimeError(
            f"EnhanceImages: DiagramImageEnhancer returned unrecognized kind "
            f"'{enhancement_result.get('kind')}'."
        )
