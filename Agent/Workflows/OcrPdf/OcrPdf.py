import asyncio
import os
import tempfile

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Generation.SyllabusPlausibilityCheck import SyllabusPlausibilityCheck
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Constants.OcrTaskPayloadKeys import OcrTaskPayloadKeys
from Globals.Enumerations.CurriculumPlausibility import CurriculumPlausibility
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.OcrModes import OcrModes
from Globals.Model.InformationSource import InformationSource
from Globals.Utility.JoinPath import join_path
from Workflows.Workflow import Workflow
from Globals.Utility.RedactSourceName import redact_source_name


class OcrPdf(Workflow):
    """
    Lands an uploaded PDF at its content-addressed path, running ocrmypdf over it
    first when OCR is on. Downstream workflows (PrepareForSimilaritySearch,
    ImageExtractor, MapTopicsWithContent, etc.) read that same path, so they all
    transparently pick up whatever this produced without any extra wiring.

    OCR is the uploader's choice (a checkbox in the upload dialog), carried here
    as the OcrModes enum on the task payload and mapped to the corresponding
    ocrmypdf flag set inside this workflow — no magic strings leak out to the
    surrounding pipeline. When it is ON the text layer is added on top of any
    existing text rather than replacing it (see _MODE_FLAG_MAP).

    This workflow runs on BOTH paths, on and off, and that is deliberate. It owns
    two things besides OCR itself:

      1. Moving a staged upload onto the content path. The upload finalizer reads
         "the content object exists" as "the source is ready", so every
         non-failing path through run() must write that object.
      2. The curriculum plausibility measurement. It records a verdict rather
         than rejecting, but it must still run on every upload — a document only
         gets measured once, and paid-deck mode reads that measurement later.
    """

    OCR_LANGUAGE = "eng"
    DEFAULT_TIMEOUT_SECONDS = 600
    OCRMYPDF_EXECUTABLE = "ocrmypdf"

    OCRABLE_SOURCE_TYPES = (
        InformationSourceTypes.PROVIDED_DOCUMENTS,
        InformationSourceTypes.CURRICULUM_OR_SYLLABUS,
        # Question papers are scanned PDFs that need OCR too — without this, a
        # fresh QUESTION_PAPER upload early-returns before writing its content
        # object, so the upload finalizer fails and the source is never saved.
        InformationSourceTypes.QUESTION_PAPER,
    )

    # OcrModes value → list of mode-specific ocrmypdf flags. Shared flags
    # (language, optimize) are appended by __build_command so each entry
    # here is purely the "what should we do with already-text pages" policy.
    #
    # ENABLED is ADDITIVE and must stay that way: --redo-ocr leaves existing
    # born-digital text exactly as it is and recognises the IMAGE regions on top
    # of it, so a PDF that already has selectable text keeps that text verbatim
    # and merely gains coverage where it had none. This is the behaviour the
    # feature promises the user, so it is not a tunable — there is deliberately
    # no user-facing mode picker, only the on/off choice in the upload dialog.
    #
    # Do not "upgrade" this to --force-ocr. We tried it to catch image regions on
    # mixed pages and it rasterizes EVERY page at --oversample dpi and re-embeds
    # it — discarding the original text layer and inflating a 5 MB upload to
    # 457 MB. --redo-ocr + higher dpi + PSM 11 chases the same recall without
    # destroying the text or paying the size cost. --skip-text is also wrong: it
    # skips a whole page that has any text at all, so diagrams on a mixed page
    # would never be recognised.
    #
    # This is the single source of the OCR flag set — the upload flow runs OCR
    # through this workflow on the worker pool (no Dock-local mirror).
    _MODE_FLAG_MAP = {
        OcrModes.ENABLED: ["--redo-ocr"],
    }

    # Tesseract page-segmentation mode 11 = "sparse text". Replaces the
    # default mode 3 (single uniform block) which fails on slide layouts
    # with scattered labels around a diagram. PSM 11 doesn't try to
    # cluster glyphs into a single column, so isolated labels in graphic
    # regions get recognised.
    TESSERACT_PAGE_SEGMENTATION_MODE = "11"

    # 400dpi catches small or anti-aliased text in slide-deck PNGs without
    # ballooning runtime. Default ocrmypdf oversample is 300dpi. Kept at 400
    # deliberately — slide/diagram uploads need the recall and we don't want to
    # compromise OCR quality for speed.
    OVERSAMPLE_DPI = "400"

    def __init__(self, payload = {}):
        super().__init__(payload)
        # The upload endpoint sends a flat InformationSource JSON (with
        # ocrMode mixed in) — NOT an ExtractableInformationSource wrapper —
        # because OCR does not need page-range metadata.
        self.__information_source: InformationSource = InformationSource.from_json(payload)
        # Optional staging input. When present, OCR reads the original from this
        # GCS key and writes the OCRed result to the content-addressed path
        # (below). The async upload flow uses this so the original never sits at
        # the content key (which would let a concurrent CAS reuse grab a
        # not-yet-OCRed object). When absent, OCR is in-place at the content path
        # (the original generation-pipeline behaviour) — fully backward compatible.
        self.__ocr_input_path = payload.get("ocrInputPath")
        # Mode is forwarded in the task payload as an integer (mirrors how other
        # enums travel between Dock and Agent). DISABLED is an ordinary, expected
        # value — it is the uploader's own choice from the upload dialog, not an
        # error state. We are still scheduled in that case because this workflow
        # is what moves a staged upload onto the content path and what applies
        # the syllabus gate; see run(). A missing or unparseable value falls back
        # to ENABLED, never to DISABLED — silently skipping OCR is the failure
        # mode that is hardest to notice.
        raw_mode_value = payload.get("ocrMode")
        if raw_mode_value is None:
            raw_mode_value = int(OcrModes.ENABLED)
        try:
            self.__ocr_mode = OcrModes(int(raw_mode_value))
        except (ValueError, TypeError):
            self.__ocr_mode = OcrModes.ENABLED

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
        await TaskManager.set_task(task)

    async def __record_curriculum_plausibility(self, pdf_bytes: bytes, information_source: InformationSource):
        """
        Runs the structural curriculum check and publishes the verdict on this
        task's payload, MERGED in so the InformationSource fields the payload
        already carries survive. The Dock upload finalizer reads it back off the
        finished task and stores it on the source row, which is the only place a
        later generation run can consult it.

        Never raises. The check is advisory metadata, not an upload gate — a
        malformed or image-only PDF simply leaves the verdict UNKNOWN, which
        every consumer treats as "not measured" rather than "failed".
        """
        try:
            plausibility = SyllabusPlausibilityCheck.evaluate(pdf_bytes)
            verdict = CurriculumPlausibility.PLAUSIBLE if plausibility["plausible"] else CurriculumPlausibility.IMPLAUSIBLE
            reason = plausibility["reason"] or ""
        except Exception as evaluation_error:
            print(
                f"[OcrPdf] Curriculum plausibility check failed for "
                f"'{redact_source_name(information_source.get_name())}' — recording UNKNOWN: {evaluation_error}"
            )
            verdict = CurriculumPlausibility.UNKNOWN
            reason = ""

        print(
            f"[OcrPdf] Curriculum plausibility for '{redact_source_name(information_source.get_name())}': "
            f"{verdict.name}{f' ({reason})' if reason else ''}."
        )

        task = await TaskManager.get_current_task()
        payload = dict(task.get_payload() or {})
        payload[OcrTaskPayloadKeys.CURRICULUM_PLAUSIBILITY] = int(verdict)
        payload[OcrTaskPayloadKeys.CURRICULUM_PLAUSIBILITY_REASON] = reason
        task.set_payload(payload)
        await TaskManager.set_task(task)

    def __build_command(self, input_path: str, output_path: str) -> list:
        mode_flags = OcrPdf._MODE_FLAG_MAP.get(self.__ocr_mode)
        if mode_flags is None:
            raise ValueError(f"[OcrPdf] No flag mapping for OcrModes value {self.__ocr_mode}.")

        # NOTE: ocrmypdf forbids --deskew, --clean-final and
        # --remove-background under --redo-ocr. Those flags are
        # intentionally absent from this list so the size-safe re-OCR
        # mode keeps working.
        return [
            OcrPdf.OCRMYPDF_EXECUTABLE,
            *mode_flags,
            "--language",                OcrPdf.OCR_LANGUAGE,
            "--oversample",              OcrPdf.OVERSAMPLE_DPI,
            "--tesseract-pagesegmode",   OcrPdf.TESSERACT_PAGE_SEGMENTATION_MODE,
            "--optimize",                "1",
            "--output-type",             "pdf",
            "--quiet",
            input_path,
            output_path,
        ]

    async def __run_ocrmypdf(self, input_path: str, output_path: str) -> None:
        command_argument_list = self.__build_command(input_path, output_path)

        process = await asyncio.create_subprocess_exec(
            *command_argument_list,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(),
                timeout=OcrPdf.DEFAULT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError(f"[OcrPdf] ocrmypdf timed out after {OcrPdf.DEFAULT_TIMEOUT_SECONDS}s.")

        if process.returncode != 0:
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip() if stderr_bytes else ""
            raise RuntimeError(
                f"[OcrPdf] ocrmypdf exited with code {process.returncode}. "
                f"stderr: {stderr_text[:1000]}"
            )

    async def run(self, args = {}):
        information_source = self.__information_source
        source_type        = information_source.get_source_type()

        # Output is always the content-addressed path (so every downstream
        # workflow reads whatever landed there). Input is the staging key when
        # the caller supplied one, else the same content path (in-place OCR).
        gcs_output_path = join_path("/", information_source.get_directory_path(), information_source.get_hash())
        gcs_input_path  = self.__ocr_input_path or gcs_output_path

        # Two independent reasons not to run ocrmypdf: the uploader turned OCR
        # off, or this source type is not something OCR applies to.
        b_ocr_requested  = self.__ocr_mode == OcrModes.ENABLED
        b_source_ocrable = source_type in OcrPdf.OCRABLE_SOURCE_TYPES
        b_should_run_ocr = b_ocr_requested and b_source_ocrable

        # A staged input means the content path is still EMPTY — the upload
        # finalizer treats "content object exists" as "the source is ready", so
        # this workflow must land something there on every path that is not an
        # outright failure. Only an in-place call (input == output) can return
        # early without writing, because there the original is already in place.
        b_input_is_staged = gcs_input_path != gcs_output_path

        if not b_should_run_ocr and not b_input_is_staged:
            skip_reason = "mode is DISABLED" if not b_ocr_requested else f"type={source_type} is not OCRable"
            print(
                f"[OcrPdf] Nothing to do for '{redact_source_name(information_source.get_name())}' "
                f"({skip_reason}, in-place) — leaving the existing object untouched."
            )
            await self.__update_progress(1.0)
            return

        pdf_bytes = await Persistence.read(gcs_input_path)
        await self.__update_progress(0.10)

        # Measure whether this document has the SHAPE of a curriculum, and record
        # the answer. Run for every PDF, whatever slot it was uploaded into.
        #
        # The upload slot used to decide this, and used to REJECT on it. That was
        # wrong on both counts. What a file is uploaded as says nothing about what
        # it is — everything arrives as a provided document, and the same PDF is
        # legitimately a curriculum in one generation run and reference material
        # in the next. The role is chosen per run, on the generation page.
        #
        # So the verdict travels with the document instead of gating the upload:
        # the check still answers the one question that matters for paid-deck mode
        # ("could a textbook be entering the pipeline wearing a syllabus label?"),
        # but it answers it once, objectively, and lets PaidDeckGenerationGate
        # apply it at the point where the claim is actually made. A normal upload
        # of a normal textbook is nobody's problem and must not fail here.
        await self.__record_curriculum_plausibility(pdf_bytes, information_source)

        # OCR was not asked for (or does not apply), but the input was staged, so
        # the content path is empty and the upload is waiting on it. Copy the
        # original across unchanged. Note this is reached only AFTER the syllabus
        # gate above — turning OCR off must not become a way around it.
        if not b_should_run_ocr:
            skip_reason = "mode is DISABLED" if not b_ocr_requested else f"type={source_type} is not OCRable"
            print(
                f"[OcrPdf] Storing '{redact_source_name(information_source.get_name())}' without OCR "
                f"({skip_reason}) — {len(pdf_bytes)} bytes written to {gcs_output_path}."
            )
            await Persistence.write(gcs_output_path, pdf_bytes)
            await self.__update_progress(1.0)
            return

        print(f"[OcrPdf] OCRing '{redact_source_name(information_source.get_name())}' with mode={self.__ocr_mode.name} (input={gcs_input_path}).")

        # ocrmypdf is a CLI tool — it needs real filesystem paths, not bytes.
        # Use NamedTemporaryFile with delete=False so we control teardown
        # even on Windows (where the file is locked while another process
        # has it open).
        input_temp  = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        output_temp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
        input_path  = input_temp.name
        output_path = output_temp.name
        input_temp.close()
        output_temp.close()

        try:
            with open(input_path, "wb") as input_file:
                input_file.write(pdf_bytes)

            await self.__update_progress(0.20)

            try:
                await self.__run_ocrmypdf(input_path, output_path)
            except Exception as ocr_error:
                # ocrmypdf could not process THIS particular PDF — e.g. an embedded
                # image it can't decode (UnsupportedImageFormatError / exit code 2),
                # a timeout, or a killed subprocess. Failing the task here loses the
                # whole source (the content object never lands, the upload finalizer
                # fails) — the "only 4 of my 5 sources" bug. A failed OCR pass must
                # not cost the user their document: fall back to storing the ORIGINAL
                # bytes at the content path so the source is still saved and usable
                # (born-digital text still extracts downstream; only the OCR layer is
                # missing). This keeps the CAS "content key is populated == ready"
                # invariant intact so the upload finalizer succeeds.
                print(
                    f"[OcrPdf] OCR failed for '{redact_source_name(information_source.get_name())}' ({ocr_error}); "
                    f"storing the original un-OCRed PDF so the source is not lost."
                )
                await Persistence.write(gcs_output_path, pdf_bytes)
                await self.__update_progress(1.0)
                return

            await self.__update_progress(0.80)

            with open(output_path, "rb") as output_file:
                ocred_pdf_bytes = output_file.read()

            # Write to the content-addressed path so every downstream workflow
            # (chunking, image extraction, topic mapping) reads the OCRed version
            # transparently. With in-place input this overwrites the original;
            # with a staging input this is the first object to land at the content
            # key — which is exactly what preserves the CAS "GCS == OCRed" invariant.
            await Persistence.write(gcs_output_path, ocred_pdf_bytes)
            await self.__update_progress(1.0)

            print(
                f"[OcrPdf] Done. Original size={len(pdf_bytes)} bytes, "
                f"OCRed size={len(ocred_pdf_bytes)} bytes — written to {gcs_output_path}."
            )
        finally:
            for path in (input_path, output_path):
                try:
                    os.unlink(path)
                except OSError:
                    pass
