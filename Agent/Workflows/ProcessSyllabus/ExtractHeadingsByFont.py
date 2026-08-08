from collections import defaultdict

from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text, looks_like_heading


def extract_headings_by_font(pdf_reader: PdfDocumentReader) -> list[dict]:

    """
    Fallback when the PDF has no embedded TOC.
    Detects headings by font size and bold flag across all pages.
    Returns a list of {'level': int, 'title': str, 'page': int}.

    Page range filtering is NOT done here — it is applied afterwards by
    FilterHeadingsByPageRange so the logic stays in one place.
    Font frequency sampling uses the full document for an accurate body-size baseline.
    """
    font_size_frequency = _get_font_freq(pdf_reader)
    size_to_level = _heading_size_levels(font_size_frequency)
    max_known_level = max(size_to_level.values(), default=0)

    headings = []
    seen: set[str] = set()

    for page_index in range(pdf_reader.get_page_count()):
        for text_line in pdf_reader.get_page_text_lines(page_index):
            title = clean_text(text_line.get_text())
            if not title or not looks_like_heading(title):
                continue

            level = size_to_level.get(round(text_line.get_maximum_font_size(), 1))
            if level is None and text_line.is_bold():
                level = max_known_level + 1

            if level is not None:
                key = title.lower()
                if key not in seen:
                    seen.add(key)
                    headings.append({"level": level, "title": title, "page": page_index + 1})

    return headings


def _get_font_freq(pdf_reader: PdfDocumentReader, max_pages: int = 40) -> dict:
    font_size_frequency: dict[float, int] = defaultdict(int)
    for page_index in range(min(pdf_reader.get_page_count(), max_pages)):
        for text_line in pdf_reader.get_page_text_lines(page_index):
            for span in text_line.get_spans():
                size = round(span.get_font_size(), 1)
                font_size_frequency[size] += span.get_word_count()
    return font_size_frequency


def _heading_size_levels(font_size_frequency: dict) -> dict[float, int]:
    if not font_size_frequency:
        return {}
    body_size = max(font_size_frequency, key=font_size_frequency.get)
    larger = sorted([size for size in font_size_frequency if size > body_size * 1.05], reverse=True)
    return {size: (level_index + 1) for level_index, size in enumerate(larger)}
