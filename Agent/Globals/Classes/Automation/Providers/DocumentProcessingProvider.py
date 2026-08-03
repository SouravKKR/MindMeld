import io
import pdfplumber

from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Classes.Generic.Persistence import Persistence
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.TaskTypes import TaskTypes


class DocumentProcessingProvider(AutomationProvider):

    async def execute(self, request: AutomationRequest) -> AutomationResponse:

        task_descriptor: TaskDescriptor = None
        document_data = None

        for content in request.get_inputs():
            match content.get_content_type():

                case AutomationContentTypes.TASK_DESCRIPTOR:
                    task_descriptor = content.get_data()

                case AutomationContentTypes.DOCUMENT:
                    document_data = content.get_data()

        if task_descriptor is None or document_data is None:
            return AutomationResponse([])

        task_type: TaskTypes = task_descriptor.get_type()

        match task_type:

            case TaskTypes.EXTRACT_DOCUMENT_CONTENT:
                return await self.__extract_document_content(document_data, task_descriptor.get_payload())

            case TaskTypes.EXTRACT_DOCUMENT_PAGES:
                return await self.__extract_document_pages(document_data, task_descriptor.get_payload())

            case _:
                return AutomationResponse([])

    # ── Private helpers ────────────────────────────────────────────────────────

    def __resolve_page_range(self, payload: dict) -> tuple[int | None, int | None]:
        if not isinstance(payload, dict):
            return None, None

        start_page = payload.get("start_page")
        end_page = payload.get("end_page")

        if start_page is not None:
            try:
                start_page = int(start_page)
            except (ValueError, TypeError):
                start_page = None

        if end_page is not None:
            try:
                end_page = int(end_page)
            except (ValueError, TypeError):
                end_page = None

        # Page numbers are 1-based, so 0 is never a real page — callers use it as
        # the "no bound on this end" sentinel. ProcessSyllabus.__compute_extraction_ranges
        # returns (0, 0) for "extract the whole document", both when the source
        # carries no page ranges and when its range covers everything.
        #
        # Mapping it to None here is what makes that sentinel mean what the caller
        # intends. Read literally, end_page=0 clamped the slice to pdf.pages[0:0]
        # — an empty page list — so a whole-document extraction returned an empty
        # string. Downstream that surfaced as "Could not derive a syllabus.
        # Provide at least one syllabus/textbook source", blaming the user's
        # perfectly good upload for a range that was never applied.
        if start_page == 0:
            start_page = None

        if end_page == 0:
            end_page = None

        return start_page, end_page

    async def __extract_pages_from_pdf(self, file_path: str, start_page: int | None, end_page: int | None) -> tuple[list[str], int, int]:
        raw_bytes = await Persistence.read(file_path)
        pdf_source = io.BytesIO(raw_bytes)

        pages_text: list[str] = []

        with pdfplumber.open(pdf_source) as pdf:
            total_pages = len(pdf.pages)

            resolved_start = max(1, start_page) if start_page is not None else 1
            resolved_end = min(end_page, total_pages) if end_page is not None else total_pages

            for page in pdf.pages[resolved_start - 1 : resolved_end]:
                text = page.extract_text(x_tolerance=2, y_tolerance=2) or ""
                pages_text.append(text)

        return pages_text, resolved_start, resolved_end

    async def __extract_document_content(self, file_path: str, payload: dict) -> AutomationResponse:
        start_page, end_page = self.__resolve_page_range(payload)

        pages_text, resolved_start, resolved_end = await self.__extract_pages_from_pdf(file_path, start_page, end_page)

        full_text = "\n\n".join(pages_text)

        metadata = {"page_count": len(pages_text)}

        if start_page is not None or end_page is not None:
            metadata["start_page"] = resolved_start
            metadata["end_page"] = resolved_end

        output = AutomationContent(
            content_type=AutomationContentTypes.TEXT,
            data=full_text,
            metadata=metadata,
        )

        return AutomationResponse([output])

    async def __extract_document_pages(self, file_path: str, payload: dict) -> AutomationResponse:
        start_page, end_page = self.__resolve_page_range(payload)

        if start_page is None or end_page is None:
            return AutomationResponse([])

        if start_page < 1 or end_page < start_page:
            return AutomationResponse([])

        pages_text, resolved_start, resolved_end = await self.__extract_pages_from_pdf(file_path, start_page, end_page)

        full_text = "\n\n".join(pages_text)

        output = AutomationContent(
            content_type=AutomationContentTypes.TEXT,
            data=full_text,
            metadata={
                "start_page": resolved_start,
                "end_page": resolved_end,
                "page_count": len(pages_text),
            },
        )

        return AutomationResponse([output])