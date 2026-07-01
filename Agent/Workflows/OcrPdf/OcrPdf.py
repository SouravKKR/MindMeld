import asyncio
import os
import tempfile

from Globals.Classes.Generic.Persistence import Persistence
from Globals.Classes.Task.TaskManager import TaskManager
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.OcrModes import OcrModes
from Globals.Model.InformationSource import InformationSource
from Globals.Utility.JoinPath import join_path
from Workflows.Workflow import Workflow


class OcrPdf(Workflow):
    """
    Runs ocrmypdf against an uploaded PDF in GCS, overwriting the original
    object in place. Downstream workflows (PrepareForSimilaritySearch,
    ImageExtractor, MapTopicsWithContent, etc.) read the same GCS path so
    they all transparently pick up the OCRed copy without any extra wiring.

    The mode comes from the user-facing OcrModes enum and is mapped to the
    corresponding ocrmypdf flag set inside this workflow — no magic strings
    leak out to the surrounding pipeline.
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
    # ENABLED uses --redo-ocr. We briefly switched to --force-ocr to OCR
    # image regions on pages that also carry born-digital text, but that
    # mode rasterizes EVERY page at --oversample dpi and re-embeds it,
    # which inflated a 5 MB upload to 457 MB. Reverted to --redo-ocr +
    # higher dpi + PSM 11 to chase recall without paying the size cost.
    # This is now the single source of the OCR flag set — the upload flow
    # runs OCR through this workflow on the worker pool (no Dock-local mirror).
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
        # Mode is forwarded in the task payload as an integer (mirrors how
        # other enums travel between Dock and Agent). DISABLED is a valid
        # safety value — the orchestrator should not have scheduled us in
        # that case, but if it does we early-return without touching GCS.
        raw_mode_value = payload.get("ocrMode", int(OcrModes.ENABLED))
        try:
            self.__ocr_mode = OcrModes(int(raw_mode_value))
        except (ValueError, TypeError):
            self.__ocr_mode = OcrModes.ENABLED

    async def __update_progress(self, completion: float):
        task = await TaskManager.get_current_task()
        task.set_completion(completion)
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

        if self.__ocr_mode == OcrModes.DISABLED:
            print(f"[OcrPdf] Mode is DISABLED for '{information_source.get_name()}' — skipping.")
            await self.__update_progress(1.0)
            return

        if source_type not in OcrPdf.OCRABLE_SOURCE_TYPES:
            print(
                f"[OcrPdf] Skipping '{information_source.get_name()}' "
                f"(type={source_type}) — OCR only applies to uploaded documents."
            )
            await self.__update_progress(1.0)
            return

        # Output is always the content-addressed path (so every downstream
        # workflow reads the OCRed copy). Input is the staging key when the
        # caller supplied one, else the same content path (in-place OCR).
        gcs_output_path = join_path("/", information_source.get_directory_path(), information_source.get_hash())
        gcs_input_path  = self.__ocr_input_path or gcs_output_path
        print(f"[OcrPdf] OCRing '{information_source.get_name()}' with mode={self.__ocr_mode.name} (input={gcs_input_path}).")

        pdf_bytes = await Persistence.read(gcs_input_path)
        await self.__update_progress(0.10)

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
                    f"[OcrPdf] OCR failed for '{information_source.get_name()}' ({ocr_error}); "
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
