from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Workflows.ProcessSyllabus.ExtractToc import extract_toc
from Workflows.ProcessSyllabus.ExtractHeadingsByFont import extract_headings_by_font
from Workflows.ProcessSyllabus.FilterHeadingsByPageRange import filter_headings_by_page_range


def extract_structure(
    pdf_bytes: bytes,
    start_page: int = 0,
    end_page: int = 0,
) -> list[dict]:
    """
    Master entry point. Accepts raw PDF bytes (from Persistence.read).
    Returns a list of {'level': int, 'title': str} ready for clean_headings.

    start_page / end_page are 1-indexed PDF page numbers, inclusive.
    If both are 0 the full document is used and no filtering is applied.

    Strategy:
      1. Extract ALL headings via embedded TOC (preferred) or font heuristics.
      2. If a page range is specified, scan the actual pages in that range
         and fuzzy-match to keep only headings present in the content —
         never trust printed page numbers from the TOC metadata.
    """
    use_full = (start_page == 0 and end_page == 0)

    with PdfDocumentReader(pdf_bytes) as pdf_reader:
        headings = extract_toc(pdf_reader)
        if not headings:
            headings = extract_headings_by_font(pdf_reader)

        if not use_full and headings:
            headings = filter_headings_by_page_range(pdf_reader, headings, start_page, end_page)

    return headings
