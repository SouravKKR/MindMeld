import asyncio
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

    # Checkpoint-resume completion marker. EnhanceImages injects enhanced figures
    # directly into the per-task flashcard / study-material JSONs, and a resumed
    # generation REUSES those JSONs verbatim (the workers skip already-written
    # topics). Re-injecting would duplicate every figure, so this marker records
    # which files have already been enhanced. Written per-file so a crash mid-run
    # resumes at the next un-enhanced file; a "complete" marker skips the whole
    # stage. Lives at Tasks/{mainTaskId}/_enhance_images_complete.json and is
    # deleted with the task folder once moveToDatabase succeeds.
    _ENHANCE_IMAGES_COMPLETE_MARKER_NAME = "_enhance_images_complete.json"

    # How many figures to enhance concurrently. Each figure is a Gemini describe
    # + GPT-Image generate (~20s wall, almost entirely awaiting the APIs), so
    # enhancing a figure-heavy deck serially (e.g. 191 figures) takes ~70 min and
    # blows any sane budget. Bounded concurrency turns that into
    # ~ceil(figures / _ENHANCE_CONCURRENCY) waves (~10 min) without overwhelming
    # the image API. Gemini describe calls are additionally capped cluster-wide by
    # the provider's RedisSemaphore; this constant bounds the GPT-Image fan-out.
    _ENHANCE_CONCURRENCY = 6

    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__generation_task_id = os.getenv("MAIN_TASK_ID")

    async def run(self, args = {}):
        if not self.__generation_task_id:
            print("[EnhanceImages] MAIN_TASK_ID not set in environment -- nothing to do.")
            return

        await self.__update_progress(0.05)

        # Checkpoint-resume: a fully-complete marker means every figure was
        # already enhanced-and-injected in a prior run, so there is nothing to do
        # (re-injecting would duplicate figures). A partial marker lists the files
        # already enhanced so the loop below skips exactly those.
        completion_marker = await self.__load_completion_marker()
        if completion_marker is not None and completion_marker.get("complete") is True:
            print("[EnhanceImages] Already complete -- figures were enhanced in a prior run (resume); skipping stage.")
            await self.__update_progress(1.0)
            return
        already_enhanced_file_paths = set((completion_marker or {}).get("enhancedFilePaths") or [])

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

        # Group assignments by their target file. Per-file lists are spliced
        # back-to-front later so the earlier-block byte offsets stay valid while
        # inserting later-block figures (the trick PrepareImages.HtmlInjector uses).
        assignments_by_file_path: dict[str, list] = {}
        for assignment in assignments:
            file_path = assignment.get("filePath")
            if not file_path:
                continue
            assignments_by_file_path.setdefault(file_path, []).append(assignment)

        # On a resumed run, files already fully enhanced-and-written must be left
        # untouched (their JSON already carries the injected figures; re-injecting
        # would duplicate them). Only the remaining files are enhanced.
        files_to_process = [file_path for file_path in assignments_by_file_path if file_path not in already_enhanced_file_paths]
        pending_assignments = [assignment for file_path in files_to_process for assignment in assignments_by_file_path[file_path]]

        if not pending_assignments:
            # Everything was already enhanced by a prior run; just finalize the marker.
            await self.__write_completion_marker(list(already_enhanced_file_paths), complete = True)
            await self.__update_progress(1.0)
            return

        await self.__update_progress(0.10)

        enhanced_file_paths = list(already_enhanced_file_paths)

        # The enhancer opens outbound HTTP clients (OpenAI + Gemini); close them in
        # the finally so the one-shot Agent subprocess can exit cleanly instead of
        # stalling interpreter teardown after the task is already marked complete.
        asset_enhancer = DiagramImageEnhancer()
        try:
            # ── Phase 1: render every pending figure CONCURRENTLY. This is the
            # slow part (GCS read + Gemini describe + GPT-Image generate, ~20s each
            # and almost entirely awaiting), and injection order is irrelevant
            # here, so a bounded semaphore lets many figures render at once. Each
            # result HTML is stashed on its assignment for the serial phase below.
            concurrency_gate = asyncio.Semaphore(EnhanceImages._ENHANCE_CONCURRENCY)
            total_pending = len(pending_assignments)
            completed_count = 0

            async def render_one(assignment):
                nonlocal completed_count
                async with concurrency_gate:
                    assignment["_enhancedHtml"] = await self.__build_enhanced_html(assignment, asset_enhancer)
                completed_count += 1
                # Phase 1 spans 0.10 -> 0.90 (the dominant cost).
                await self.__update_progress(0.10 + 0.80 * (completed_count / total_pending))

            render_results = await asyncio.gather(
                *[render_one(assignment) for assignment in pending_assignments],
                return_exceptions = True,
            )
            # A structural failure (missing gcsImagePath / unreadable figure bytes)
            # must fail the whole task so a partially-enhanced deck is never
            # persisted. Enhancement failures do NOT raise -- they fall back to the
            # original figure inside __build_enhanced_html -- so any exception here
            # is a hard error worth propagating.
            for render_result in render_results:
                if isinstance(render_result, Exception):
                    raise render_result

            # ── Phase 2: splice the pre-rendered figures into each file's HTML and
            # persist. Serial + per-file so the back-to-front block splicing stays
            # correct and the completion marker advances file-by-file (resume-safe).
            for processed_file_count, file_path in enumerate(files_to_process, start = 1):
                file_document = await self.__load_json_file(file_path)
                if file_document is None:
                    # PrepareImages flagged this file path but we can't read it back
                    # -- treat as a hard error so moveToDatabase doesn't persist a
                    # partially-enhanced deck.
                    raise RuntimeError(
                        f"EnhanceImages: assignment references unreadable file '{file_path}'."
                    )

                self.__inject_assignments_into_file(file_document, assignments_by_file_path[file_path])

                await Persistence.write(file_path, json.dumps(file_document, ensure_ascii = False))

                # Record the file as enhanced immediately after its write so a crash
                # here resumes at the next file, never re-injecting this one.
                enhanced_file_paths.append(file_path)
                await self.__write_completion_marker(enhanced_file_paths, complete = False)
                await self.__update_progress(0.90 + 0.10 * (processed_file_count / len(files_to_process)))
        finally:
            await asset_enhancer.close()

        await self.__write_completion_marker(enhanced_file_paths, complete = True)

        print(
            f"[EnhanceImages] Done. Enhanced {len(pending_assignments)} figure(s) across "
            f"{len(files_to_process)} file(s)."
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

    def __completion_marker_path(self) -> str:
        return join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            self.__generation_task_id,
            EnhanceImages._ENHANCE_IMAGES_COMPLETE_MARKER_NAME,
        )

    async def __load_completion_marker(self) -> dict | None:
        """
        Reads the per-file completion marker, or None when absent. A corrupt or
        unreadable marker is treated as absent (start fresh) so a resume is never
        blocked by it -- the only cost is possibly re-enhancing a file, which is
        strictly better than dead-ending the run.
        """
        marker_path = self.__completion_marker_path()
        if not await Persistence.exists(marker_path):
            return None
        try:
            marker_bytes = await Persistence.read(marker_path)
            return json.loads(marker_bytes.decode("utf-8"))
        except Exception as load_error:
            print(f"[EnhanceImages] Ignoring unreadable completion marker at {marker_path}: {load_error}")
            return None

    async def __write_completion_marker(self, enhanced_file_paths: list, complete: bool):
        marker_document = {
            "version": 1,
            "complete": complete,
            "enhancedFilePaths": enhanced_file_paths,
        }
        await Persistence.write(
            self.__completion_marker_path(),
            json.dumps(marker_document, ensure_ascii = False),
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

    def __inject_assignments_into_file(self, file_document: dict, file_assignments: list):
        """
        Splices every pre-rendered assignment for a single content file into its
        HTML. The enhanced figure HTML was produced concurrently in phase 1 and
        stashed on each assignment, so this does only the fast, in-memory splicing.
        Study materials carry a single "content" field; flashcards carry a list of
        cards each with question/answer fields. We dispatch on the assignment's
        `fileType` rather than peeking at the document shape so an unexpected
        payload fails loudly.
        """
        # Inserting figures at later block positions FIRST keeps earlier-block byte
        # offsets valid for the subsequent inserts in the same field.
        for assignment in sorted(file_assignments, key = lambda a: a.get("blockIndex", 0), reverse = True):
            replacement_html = assignment.get("_enhancedHtml")
            if not replacement_html:
                continue
            file_type = assignment.get("fileType")
            if file_type == "studyMaterial":
                self.__inject_into_study_material(file_document, assignment, replacement_html)
            elif file_type == "flashcard":
                self.__inject_into_flashcard(file_document, assignment, replacement_html)
            else:
                raise RuntimeError(
                    f"EnhanceImages: unrecognized assignment fileType '{file_type}'."
                )

    def __inject_into_study_material(self, study_material_document: dict, assignment: dict, replacement_html: str):
        content_html = study_material_document.get("content") or ""
        block_elements = HtmlInjector.extract_block_elements(content_html)
        if not block_elements:
            return

        target_block_index = min(assignment.get("blockIndex", 0), len(block_elements) - 1)
        insertion_position = block_elements[target_block_index]["end"]

        study_material_document["content"] = HtmlInjector.inject_figure_after_block(
            content_html, insertion_position, replacement_html
        )

    def __inject_into_flashcard(self, flashcard_document: dict, assignment: dict, replacement_html: str):
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
