"""
Verification harness for the per-upload OCR choice (OcrModes DISABLED/ENABLED).

Run from the Agent directory:
    .venv/Scripts/python.exe Verification/VerifyOcrModeSelection.py    (Windows)
    .venv/bin/python Verification/VerifyOcrModeSelection.py            (Linux)

Needs no network, no GCS and no services: Persistence and TaskManager are stubbed
so every case is a pure decision-matrix check against OcrPdf.run().

What it protects. The upload finalizer in Dock treats "the content object exists"
as "the source is ready" and FAILS the whole upload when it does not. OcrPdf is
the only thing that writes that object, so every non-failing path through run()
must land it. Before the OCR toggle existed the DISABLED path early-returned
without writing, which would have turned "I turned OCR off" into "my upload
failed" -- that is the regression this file exists to catch.

It also pins two things that are easy to erode later:
  * the syllabus plausibility gate runs even when OCR is off, so turning OCR off
    is not a way around it; and
  * ENABLED means --redo-ocr, which ADDS a text layer over the image regions and
    leaves existing born-digital text intact.
"""

import asyncio
import sys
from pathlib import Path

AGENT_DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(AGENT_DIRECTORY))

from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.OcrModes import OcrModes
from Globals.Utility.JoinPath import join_path

from Workflows.OcrPdf.OcrPdf import OcrPdf


passed_count = 0
failed_count = 0

CONTENT_DIRECTORY = "/InformationSources/user-1"
CONTENT_HASH = "abc123"
# Derived with the SAME helper the workflow uses rather than hand-spelled --
# join_path strips the leading separator, so a hardcoded "/a/b" would never match
# what the workflow actually writes and every assertion here would fail for a
# reason that has nothing to do with OCR.
CONTENT_PATH = join_path("/", CONTENT_DIRECTORY, CONTENT_HASH)
STAGING_PATH = "/Tasks/task-1/original"

ORIGINAL_BYTES = b"%PDF-1.4 original bytes"
OCRED_BYTES = b"%PDF-1.4 ocred bytes"


def assert_that(condition: bool, description: str) -> None:
    global passed_count, failed_count
    if condition:
        passed_count += 1
        print(f"  PASS  {description}")
    else:
        failed_count += 1
        print(f"  FAIL  {description}")


def section(title: str) -> None:
    print(f"\n=== {title} ===")


class PersistenceRecorder:
    """Stands in for the real Persistence, recording every write."""

    def __init__(self, stored_bytes: bytes = ORIGINAL_BYTES):
        self.writes = {}
        self.reads = []
        self.__stored_bytes = stored_bytes

    async def read(self, file_path, target=None):
        self.reads.append(file_path)
        return self.__stored_bytes

    async def write(self, file_path, data, target=None):
        self.writes[file_path] = data


def install_stubs(recorder: PersistenceRecorder, b_ocr_should_succeed: bool = True) -> None:
    """
    Points OcrPdf's collaborators at the recorder. OcrPdf imported Persistence
    and TaskManager by name, so the names are replaced in ITS module namespace --
    patching the source modules alone would not be seen by the already-imported
    workflow.
    """
    import Workflows.OcrPdf.OcrPdf as OcrPdfModule

    OcrPdfModule.Persistence = recorder

    class TaskStub:
        def set_completion(self, value):
            pass

    class TaskManagerStub:
        @staticmethod
        async def get_current_task():
            return TaskStub()

        @staticmethod
        async def set_task(task):
            pass

    OcrPdfModule.TaskManager = TaskManagerStub

    # Replace the ocrmypdf subprocess call. The real binary is not necessarily on
    # PATH on a dev box, and this harness is about the decision matrix, not about
    # tesseract's output.
    async def fake_run_ocrmypdf(self, input_path, output_path):
        if not b_ocr_should_succeed:
            raise RuntimeError("simulated ocrmypdf failure")
        with open(output_path, "wb") as output_file:
            output_file.write(OCRED_BYTES)

    OcrPdf._OcrPdf__run_ocrmypdf = fake_run_ocrmypdf


def build_payload(ocr_mode, source_type=InformationSourceTypes.PROVIDED_DOCUMENTS, b_staged=True) -> dict:
    payload = {
        "name": "Some Textbook.pdf",
        "userId": "user-1",
        "sourceType": int(source_type),
        "directoryPath": CONTENT_DIRECTORY,
        "hash": CONTENT_HASH,
        "tags": [],
        "mimeType": "application/pdf",
        "retentionMode": 1,
        "fileSizeBytes": 1234,
        "expiresAt": 0,
        "uploadedAt": 0,
    }

    if ocr_mode is not None:
        payload["ocrMode"] = int(ocr_mode)

    if b_staged:
        payload["ocrInputPath"] = STAGING_PATH

    return payload


async def run_workflow(payload, b_ocr_should_succeed=True) -> PersistenceRecorder:
    recorder = PersistenceRecorder()
    install_stubs(recorder, b_ocr_should_succeed)
    await OcrPdf(payload).run()
    return recorder


async def main() -> None:
    section("A staged upload always lands the content object (the upload finalizer depends on it)")

    recorder = await run_workflow(build_payload(OcrModes.ENABLED))
    assert_that(CONTENT_PATH in recorder.writes, "OCR ENABLED writes the content object")
    assert_that(recorder.writes.get(CONTENT_PATH) == OCRED_BYTES, "OCR ENABLED stores the OCRed bytes")
    assert_that(STAGING_PATH in recorder.reads, "OCR ENABLED reads from the staging key")

    recorder = await run_workflow(build_payload(OcrModes.DISABLED))
    assert_that(CONTENT_PATH in recorder.writes, "OCR DISABLED still writes the content object")
    assert_that(
        recorder.writes.get(CONTENT_PATH) == ORIGINAL_BYTES,
        "OCR DISABLED stores the ORIGINAL bytes, byte for byte",
    )

    recorder = await run_workflow(
        build_payload(OcrModes.DISABLED, source_type=InformationSourceTypes.QUESTION_PAPER)
    )
    assert_that(CONTENT_PATH in recorder.writes, "OCR DISABLED on a question paper still lands the object")

    recorder = await run_workflow(
        build_payload(OcrModes.ENABLED, source_type=InformationSourceTypes.AI_GENERATED)
    )
    assert_that(
        CONTENT_PATH in recorder.writes,
        "a non-OCRable source type still lands the object rather than stranding the upload",
    )
    assert_that(
        recorder.writes.get(CONTENT_PATH) == ORIGINAL_BYTES,
        "a non-OCRable source type stores the original unchanged",
    )

    section("A failed OCR pass must not cost the user their document")

    recorder = await run_workflow(build_payload(OcrModes.ENABLED), b_ocr_should_succeed=False)
    assert_that(CONTENT_PATH in recorder.writes, "an ocrmypdf failure still lands the content object")
    assert_that(
        recorder.writes.get(CONTENT_PATH) == ORIGINAL_BYTES,
        "an ocrmypdf failure falls back to the original bytes",
    )

    section("A mode that is missing or malformed must never silently mean DISABLED")

    recorder = await run_workflow(build_payload(None))
    assert_that(recorder.writes.get(CONTENT_PATH) == OCRED_BYTES, "an omitted ocrMode is treated as ENABLED")

    payload_with_null_mode = build_payload(None)
    payload_with_null_mode["ocrMode"] = None
    recorder = await run_workflow(payload_with_null_mode)
    assert_that(recorder.writes.get(CONTENT_PATH) == OCRED_BYTES, "a null ocrMode is treated as ENABLED")

    # A value that is present but not a valid OcrModes member is rejected by the
    # generated InformationSource.from_json before this workflow sees it. That is
    # a LOUD failure (the task fails, the upload reports an error) rather than a
    # quiet skip, which is the safe direction -- so it is pinned deliberately.
    # Dock never sends such a value: InformationSourceUpload normalises the raw
    # metadata to exactly DISABLED or ENABLED before the task is built, because
    # the generated setOcrMode would otherwise coerce garbage to DISABLED.
    payload_with_junk_mode = build_payload(None)
    payload_with_junk_mode["ocrMode"] = "not-a-number"

    b_rejected_junk = False
    try:
        await run_workflow(payload_with_junk_mode)
    except ValueError:
        b_rejected_junk = True

    assert_that(b_rejected_junk, "a malformed ocrMode fails loudly instead of silently skipping OCR")

    section("An in-place call with nothing to do leaves the existing object alone")

    recorder = await run_workflow(build_payload(OcrModes.DISABLED, b_staged=False))
    assert_that(len(recorder.writes) == 0, "DISABLED + in-place writes nothing (the original is already there)")

    section("Turning OCR off is not a way around the syllabus plausibility gate")

    import Workflows.OcrPdf.OcrPdf as OcrPdfModule

    evaluated_calls = []

    class RejectingSyllabusCheck:
        @staticmethod
        def evaluate(pdf_bytes):
            evaluated_calls.append(len(pdf_bytes))
            return {"plausible": False, "reason": "looks like a textbook, not a syllabus"}

    original_check = OcrPdfModule.SyllabusPlausibilityCheck
    OcrPdfModule.SyllabusPlausibilityCheck = RejectingSyllabusCheck

    try:
        b_rejected = False
        try:
            await run_workflow(
                build_payload(OcrModes.DISABLED, source_type=InformationSourceTypes.CURRICULUM_OR_SYLLABUS)
            )
        except RuntimeError:
            b_rejected = True

        assert_that(b_rejected, "a mislabelled syllabus is rejected even with OCR DISABLED")
        assert_that(len(evaluated_calls) == 1, "the plausibility gate actually ran on the DISABLED path")
    finally:
        OcrPdfModule.SyllabusPlausibilityCheck = original_check

    section("ENABLED is the additive mode -- existing text is kept, OCR goes on top")

    enabled_flags = OcrPdf._MODE_FLAG_MAP.get(OcrModes.ENABLED)
    assert_that(enabled_flags == ["--redo-ocr"], "ENABLED maps to --redo-ocr")
    assert_that(
        "--force-ocr" not in (enabled_flags or []),
        "ENABLED does NOT use --force-ocr (it rasterizes every page and discards the text layer)",
    )
    assert_that(
        "--skip-text" not in (enabled_flags or []),
        "ENABLED does NOT use --skip-text (it would skip whole pages that carry any text)",
    )
    assert_that(
        OcrModes.DISABLED not in OcrPdf._MODE_FLAG_MAP,
        "DISABLED has no flag mapping -- it must never reach the ocrmypdf command builder",
    )

    print("\n=== Summary ===")
    print(f"  passed:  {passed_count}")
    print(f"  failed:  {failed_count}")

    sys.exit(1 if failed_count else 0)


asyncio.run(main())
