import fitz
from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text, looks_like_heading


def extract_toc(doc: fitz.Document) -> list[dict]:
    """
    Pull ALL entries from the embedded PDF Table of Contents.
    Returns a list of {'level': int, 'title': str}, or [] if none.
    Page numbers from the TOC metadata are intentionally ignored —
    they reflect printed page numbers, not PDF page indices.
    """
    raw_toc = doc.get_toc(simple=False)
    if not raw_toc:
        return []

    entries = []
    for item in raw_toc:
        level, title = item[0], item[1]
        title = clean_text(title)
        if title and looks_like_heading(title):
            entries.append({"level": level, "title": title})
    return entries