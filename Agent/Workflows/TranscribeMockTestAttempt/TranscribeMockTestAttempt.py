import io
import json
import os
import re

from datetime import datetime, timezone

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.ModelPool import ModelPool
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Generic.TokenSafeContent import TokenSafeContent
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.MockTestEvaluationConstants import MockTestEvaluationConstants
from Globals.Constants.PersistenceConstants import PersistenceConstants
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.JoinPath import join_path
from Globals.Utility.StripJsonMarkdown import strip_json_markdown
from Workflows.Workflow import Workflow


class TranscribeMockTestAttempt(Workflow):
    """
    Reads a candidate's scanned, handwritten answer sheet for an OFFLINE
    mock-test attempt and transcribes it into per-question HTML answers, mapping
    each answer to its question by the question number the candidate wrote on the
    left of each block.

    This is the ONE thing offline evaluation adds ahead of the normal grading
    pipeline: the output (TranscribedAnswers.json) is surfaced to the candidate
    for review/correction, and the confirmed answers then flow into the exact
    same evaluation path an online attempt uses. The scans themselves never reach
    the grader — only the transcribed text does.

    The Dock endpoint stages the request + scan blobs under the task directory:
        Tasks/{taskId}/MockTestTranscriptions/TranscriptionRequest.json
        Tasks/{taskId}/MockTestTranscriptions/scan_0.<ext>, scan_1.<ext>, ...
    and reads TranscribedAnswers.json back from the same directory.
    """

    # A phone photo of an A4 sheet at ~1600px on the long edge is comfortably
    # legible to the vision model while keeping the request small; larger images
    # cost tokens without improving handwriting recall.
    SCAN_IMAGE_MAX_EDGE_PIXELS = 1600

    # DPI to rasterize PDF pages at before the edge-cap downscale above. 200 DPI
    # captures handwriting cleanly; the subsequent cap keeps the PNG bounded.
    PDF_RASTER_DPI = 200

    # Hard ceiling on the number of page images sent in a single request — a
    # runaway upload (e.g. a 300-page PDF) must not blow the model's image limit
    # or the request size. Extra pages beyond this are dropped and logged.
    MAX_SCAN_PAGES = 24

    # Question text is context that helps the model map answers to questions; it
    # does not need the full body, so cap it well below the answer budget.
    QUESTION_TEXT_TOKEN_CAP = 400

    HTML_TAG_PATTERN = re.compile(r"<[^>]+>")
    WHITESPACE_PATTERN = re.compile(r"\s+")

    def __init__(self, payload = {}):
        super().__init__(payload)

    async def run(self, args = {}):
        main_task_id = os.getenv("MAIN_TASK_ID")
        parent_task_id = os.getenv("PARENT_TASK_ID") or main_task_id

        worker_id = os.getenv("TASK_ID", "unknown")
        log_lines = []

        def write_log(message: str):
            print(message)
            log_lines.append(message)

        async def flush_log():
            try:
                log_path = join_path(
                    "/",
                    PersistenceConstants.TASKS_DIRECTORY,
                    main_task_id,
                    f"Worker_{worker_id}.log",
                )
                await Persistence.write(log_path, "\n".join(log_lines))
            except Exception as write_log_error:
                print(f"[TranscribeMockTestAttempt] Could not write worker log: {write_log_error}")

        write_log(f"[TranscribeMockTestAttempt] Starting. task={worker_id} main={main_task_id} parent={parent_task_id}")
        await flush_log()

        transcriptions_directory = join_path(
            "/",
            PersistenceConstants.TASKS_DIRECTORY,
            main_task_id,
            PersistenceConstants.MOCK_TEST_TRANSCRIPTIONS_DIRECTORY,
        )
        request_path = join_path(
            transcriptions_directory,
            MockTestEvaluationConstants.TRANSCRIPTION_REQUEST_FILENAME,
        )

        try:
            raw_request = await Persistence.read(request_path)
            request_payload = json.loads(raw_request.decode("utf-8"))
        except Exception as load_error:
            write_log(f"[TranscribeMockTestAttempt] FATAL: Could not read transcription request at '{request_path}': {load_error}")
            await flush_log()
            raise

        questions = request_payload.get("questions", []) or []
        exam_name = request_payload.get("examName") or "General"
        subject_name = request_payload.get("subjectName") or "the subject"
        scan_file_names = request_payload.get("scanFiles", []) or []

        write_log(
            f"[TranscribeMockTestAttempt] Loaded request: questionCount={len(questions)} "
            f"scanFileCount={len(scan_file_names)}"
        )
        await TaskManager.increment_completion(parent_task_id, 0.1)

        # ── Load + normalize every scan page into PNG bytes ─────────────────────
        page_images = await self.__load_scan_images(transcriptions_directory, scan_file_names, write_log)
        write_log(f"[TranscribeMockTestAttempt] Prepared {len(page_images)} page image(s) for transcription.")

        # The scans are now normalized PNG bytes held in memory, and nothing
        # reads the stored copies again — not this workflow, not evaluation, and
        # not the client (GetTranscriptionResult returns the transcription JSON
        # alone, and the review page renders the File objects the browser still
        # holds). A retry re-uploads from the browser as a brand-new task rather
        # than re-reading these, so keeping them for retry would be pointless.
        #
        # Deleting at the earliest safe point rather than at the end means every
        # later failure path — LLM error, write failure, a killed worker — also
        # leaves nothing behind, so no separate sweeper is needed. These are
        # photographs of a named student's handwriting that frequently capture
        # the printed question paper too; retaining them past use has no
        # product justification.
        await self.__delete_scan_files(transcriptions_directory, scan_file_names, write_log)
        await TaskManager.increment_completion(parent_task_id, 0.2)
        await flush_log()

        transcription_failed = False
        answers_by_question_id = {}
        unmatched_blocks = []

        if not questions:
            write_log("[TranscribeMockTestAttempt] No questions in request; writing empty transcription.")
        elif not page_images:
            # Candidate submitted no readable scans (or upload was empty). Every
            # question falls back to a blank answer the reviewer can fill in by
            # hand — a valid outcome, not a failure.
            write_log("[TranscribeMockTestAttempt] No page images available; emitting blank answers for review.")
        else:
            request = self.__build_transcription_request(questions, page_images, exam_name, subject_name)
            validator = TranscribeMockTestAttempt.__build_validator(questions, write_log)
            live_caller = AutomationCaller(GoogleEnterpriseAiProvider())

            try:
                response = await live_caller.call(request, validator)
            except Exception as live_call_error:
                write_log(f"[TranscribeMockTestAttempt] Live transcription call raised: {live_call_error}")
                response = None

            if response is None:
                transcription_failed = True
                write_log("[TranscribeMockTestAttempt] Transcription call produced no valid response; falling back to blank answers.")
            else:
                try:
                    raw_data = response.get_output().get_data()
                    parsed = strip_json_markdown(raw_data) if isinstance(raw_data, str) else raw_data
                except Exception as parse_error:
                    transcription_failed = True
                    parsed = None
                    write_log(f"[TranscribeMockTestAttempt] Failed to parse transcription response: {parse_error}")

                if isinstance(parsed, dict):
                    for answer_entry in parsed.get("answers", []) or []:
                        if not isinstance(answer_entry, dict):
                            continue
                        question_id = answer_entry.get("questionId")
                        if question_id is None:
                            continue
                        answer_value = answer_entry.get("answer")
                        answers_by_question_id[str(question_id)] = {
                            "questionNumber": str(answer_entry.get("questionNumber") or ""),
                            "answer": answer_value if isinstance(answer_value, str) else "",
                        }
                    for unmatched_entry in parsed.get("unmatched", []) or []:
                        if not isinstance(unmatched_entry, dict):
                            continue
                        unmatched_answer = unmatched_entry.get("answer")
                        unmatched_blocks.append({
                            "questionNumberSeen": str(unmatched_entry.get("questionNumberSeen") or ""),
                            "answer": unmatched_answer if isinstance(unmatched_answer, str) else "",
                        })

        # ── Assemble one answer per question, in question order ─────────────────
        answered_count = 0
        answer_outputs = []
        for question_row in questions:
            question_id = str(question_row.get("questionId"))
            transcribed = answers_by_question_id.get(question_id)
            answer_value = transcribed["answer"] if transcribed else ""
            question_number = (transcribed or {}).get("questionNumber") or str(question_row.get("questionNumber") or "")
            if answer_value.strip():
                answered_count += 1
            answer_outputs.append({
                "questionId": question_id,
                "questionNumber": question_number,
                "answer": answer_value,
            })

        output_document = {
            "mockTestId": request_payload.get("mockTestId"),
            "attemptId": request_payload.get("attemptId"),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "answers": answer_outputs,
            "unmatched": unmatched_blocks,
            "summary": {
                "questionCount": len(questions),
                "answeredCount": answered_count,
                "blankCount": len(questions) - answered_count,
                "unmatchedCount": len(unmatched_blocks),
                "pageCount": len(page_images),
                "transcriptionFailed": transcription_failed,
            },
        }

        output_path = join_path(
            transcriptions_directory,
            MockTestEvaluationConstants.TRANSCRIBED_ANSWERS_OUTPUT_FILENAME,
        )

        try:
            await Persistence.write(output_path, json.dumps(output_document, ensure_ascii = False))
            write_log(f"[TranscribeMockTestAttempt] Wrote transcription to '{output_path}'")
        except Exception as write_error:
            write_log(f"[TranscribeMockTestAttempt] WRITE FAILED for transcription: {write_error}")
            await flush_log()
            raise

        write_log(
            f"[TranscribeMockTestAttempt] Done. answered={answered_count}/{len(questions)} "
            f"unmatched={len(unmatched_blocks)} failed={transcription_failed}"
        )
        await flush_log()

    @staticmethod
    async def __delete_scan_files(transcriptions_directory, scan_file_names, write_log):
        """
        Removes the uploaded answer-sheet images from storage once they have been
        loaded into memory.

        A deletion failure never fails the task — the images are already in hand
        and the transcription can still be produced. The failure is logged so a
        storage problem is visible rather than silently leaving scans behind.
        """
        deleted_count = 0
        for scan_file_name in scan_file_names or []:
            try:
                await Persistence.delete(join_path(transcriptions_directory, scan_file_name))
                deleted_count += 1
            except Exception as delete_error:
                write_log(f"[TranscribeMockTestAttempt] Could not delete scan '{scan_file_name}': {delete_error}")

        write_log(f"[TranscribeMockTestAttempt] Deleted {deleted_count}/{len(scan_file_names or [])} scan file(s) after transcription.")

    # ── Scan loading / image normalization ──────────────────────────────────────

    async def __load_scan_images(self, transcriptions_directory, scan_file_names, write_log):
        page_images = []
        for scan_file_name in scan_file_names:
            if len(page_images) >= TranscribeMockTestAttempt.MAX_SCAN_PAGES:
                write_log(
                    f"[TranscribeMockTestAttempt] Reached MAX_SCAN_PAGES="
                    f"{TranscribeMockTestAttempt.MAX_SCAN_PAGES}; dropping remaining scans."
                )
                break

            scan_path = join_path(transcriptions_directory, scan_file_name)
            try:
                scan_bytes = await Persistence.read(scan_path)
            except Exception as read_error:
                write_log(f"[TranscribeMockTestAttempt] Could not read scan '{scan_path}': {read_error}")
                continue

            if TranscribeMockTestAttempt.__looks_like_pdf(scan_bytes, scan_file_name):
                remaining_slots = TranscribeMockTestAttempt.MAX_SCAN_PAGES - len(page_images)
                for page_png in TranscribeMockTestAttempt.__rasterize_pdf(scan_bytes, remaining_slots, write_log):
                    page_images.append(page_png)
            else:
                normalized_png = TranscribeMockTestAttempt.__normalize_image_to_png(scan_bytes, write_log)
                if normalized_png is not None:
                    page_images.append(normalized_png)

        return page_images

    @staticmethod
    def __looks_like_pdf(scan_bytes, scan_file_name):
        if isinstance(scan_file_name, str) and scan_file_name.lower().endswith(".pdf"):
            return True
        return isinstance(scan_bytes, (bytes, bytearray)) and scan_bytes[:5] == b"%PDF-"

    @staticmethod
    def __rasterize_pdf(pdf_bytes, remaining_slots, write_log):
        page_pngs = []
        try:
            import fitz

            document = fitz.open(stream=pdf_bytes, filetype="pdf")
            try:
                for page_index in range(min(document.page_count, remaining_slots)):
                    page = document.load_page(page_index)
                    pixmap = page.get_pixmap(dpi=TranscribeMockTestAttempt.PDF_RASTER_DPI)
                    normalized_png = TranscribeMockTestAttempt.__normalize_image_to_png(pixmap.tobytes("png"), write_log)
                    if normalized_png is not None:
                        page_pngs.append(normalized_png)
            finally:
                document.close()
        except Exception as raster_error:
            write_log(f"[TranscribeMockTestAttempt] PDF rasterization failed: {raster_error}")
        return page_pngs

    @staticmethod
    def __normalize_image_to_png(image_bytes, write_log):
        try:
            from PIL import Image, ImageOps

            with Image.open(io.BytesIO(image_bytes)) as opened_image:
                # Honour EXIF orientation so sideways phone photos come out
                # upright — the model reads upright handwriting far better.
                oriented_image = ImageOps.exif_transpose(opened_image)
                if oriented_image.mode not in ("RGB", "L"):
                    oriented_image = oriented_image.convert("RGB")

                longest_edge = max(oriented_image.width, oriented_image.height)
                maximum_edge = TranscribeMockTestAttempt.SCAN_IMAGE_MAX_EDGE_PIXELS
                if longest_edge > maximum_edge:
                    scale_factor = maximum_edge / float(longest_edge)
                    resized_width = max(1, int(oriented_image.width * scale_factor))
                    resized_height = max(1, int(oriented_image.height * scale_factor))
                    oriented_image = oriented_image.resize((resized_width, resized_height), Image.LANCZOS)

                output_buffer = io.BytesIO()
                oriented_image.save(output_buffer, format="PNG")
                return output_buffer.getvalue()
        except Exception as normalize_error:
            write_log(f"[TranscribeMockTestAttempt] Image normalization failed: {normalize_error}")
            return None

    # ── Prompt construction ─────────────────────────────────────────────────────

    def __build_transcription_request(self, questions, page_images, exam_name, subject_name):
        question_block_texts = []
        for question_row in questions:
            question_text = TokenSafeContent.cap_content_for_prompt(
                TranscribeMockTestAttempt.__strip_html(question_row.get("question") or ""),
                max_tokens = TranscribeMockTestAttempt.QUESTION_TEXT_TOKEN_CAP,
                label = f"transcription question#{question_row.get('questionNumber')}",
            )

            block_text = (
                f"questionId: {question_row.get('questionId')}\n"
                f"questionNumber: {question_row.get('questionNumber')}\n"
                f"typeKey: {question_row.get('typeKey')}\n"
                f"Question: {question_text}\n"
            )

            options_array = question_row.get("options")
            if isinstance(options_array, list) and len(options_array) > 0:
                option_lines = [f"  [{option_index}] {option_text}" for option_index, option_text in enumerate(options_array)]
                block_text += "Options:\n" + "\n".join(option_lines) + "\n"

            question_block_texts.append(block_text)

        system_text = PromptPool.MOCK_TEST_TRANSCRIPTION_SYSTEM
        user_prompt = (
            PromptPool.MOCK_TEST_TRANSCRIPTION_USER
            .replace("{exam_name}", exam_name)
            .replace("{subject_name}", subject_name)
            .replace("{questions_block}", "\n---\n".join(question_block_texts))
            .replace("{question_count}", str(len(questions)))
        )

        transcription_model_string, _provider_class = ModelPool.MOCK_TEST_TRANSCRIPTION_MODEL

        request_inputs = [
            AutomationContent(AutomationContentTypes.SYSTEM, system_text),
            AutomationContent(AutomationContentTypes.TEXT, user_prompt),
        ]
        for page_png in page_images:
            request_inputs.append(AutomationContent(AutomationContentTypes.IMAGE, page_png))

        return AutomationRequest(transcription_model_string, request_inputs)

    # ── Validation ──────────────────────────────────────────────────────────────

    @staticmethod
    def __build_validator(questions, write_log):
        known_question_ids = {str(question_row.get("questionId")) for question_row in questions}

        def _preview_raw(raw_data) -> str:
            try:
                text = raw_data if isinstance(raw_data, str) else json.dumps(raw_data, ensure_ascii=False)
            except Exception:
                text = str(raw_data)
            preview_length = 400
            return text[:preview_length].replace("\n", " ") + ("…" if len(text) > preview_length else "")

        def validator(response) -> bool:
            try:
                raw_data = response.get_output().get_data()
                parsed = strip_json_markdown(raw_data) if isinstance(raw_data, str) else raw_data

                if not isinstance(parsed, dict):
                    write_log(f"[Validator] Transcription is not an object. type={type(parsed).__name__}. raw_preview={_preview_raw(raw_data)}")
                    return False

                answers = parsed.get("answers")
                if not isinstance(answers, list):
                    write_log(f"[Validator] 'answers' is not a list. raw_preview={_preview_raw(raw_data)}")
                    return False

                for answer_entry in answers:
                    if not isinstance(answer_entry, dict):
                        write_log(f"[Validator] answer entry is not a dict: {answer_entry}")
                        return False
                    question_id = answer_entry.get("questionId")
                    if question_id is None or str(question_id) not in known_question_ids:
                        write_log(f"[Validator] answer entry has unknown questionId: {question_id}")
                        return False
                    if not isinstance(answer_entry.get("answer"), str):
                        write_log(f"[Validator] answer entry 'answer' is not a string: {answer_entry}")
                        return False

                unmatched = parsed.get("unmatched", [])
                if unmatched is not None and not isinstance(unmatched, list):
                    write_log(f"[Validator] 'unmatched' is present but not a list.")
                    return False

                return True
            except Exception as validation_error:
                write_log(f"[Validator] Exception: {validation_error}")
                return False

        return validator

    # ── Helpers ─────────────────────────────────────────────────────────────────

    @staticmethod
    def __strip_html(value):
        if not value:
            return ""
        collapsed = TranscribeMockTestAttempt.HTML_TAG_PATTERN.sub(" ", str(value))
        return TranscribeMockTestAttempt.WHITESPACE_PATTERN.sub(" ", collapsed).strip()
