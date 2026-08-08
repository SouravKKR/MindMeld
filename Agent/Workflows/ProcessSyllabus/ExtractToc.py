from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text, looks_like_heading


def extract_toc(pdf_reader: PdfDocumentReader) -> list[dict]:
    """
    Pull ALL entries from the embedded PDF Table of Contents.
    Returns a list of {'level': int, 'title': str}, or [] if none.
    Page numbers from the TOC metadata are intentionally ignored —
    they reflect printed page numbers, not PDF page indices.
    """
    outline_entries = pdf_reader.get_outline_entries()
    if not outline_entries:
        return []

    entries = []
    for outline_entry in outline_entries:
        title = clean_text(outline_entry["title"])
        if title and looks_like_heading(title):
            entries.append({"level": outline_entry["level"], "title": title})
    return entries
