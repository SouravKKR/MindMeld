from collections import defaultdict
import fitz

from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text, looks_like_heading


def extract_headings_by_font(doc: fitz.Document) -> list[dict]:
    
    """
    Fallback when the PDF has no embedded TOC.
    Detects headings by font size and bold flag across all pages.
    Returns a list of {'level': int, 'title': str, 'page': int}.

    Page range filtering is NOT done here — it is applied afterwards by
    FilterHeadingsByPageRange so the logic stays in one place.
    Font frequency sampling uses the full document for an accurate body-size baseline.
    """
    freq = _get_font_freq(doc)
    size_to_level = _heading_size_levels(freq)
    max_known_level = max(size_to_level.values(), default=0)

    headings = []
    seen: set[str] = set()

    for page_num in range(len(doc)):
        try:
            blocks = doc[page_num].get_text("dict")["blocks"]
        except Exception:
            continue

        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                parts, max_size, is_bold = [], 0.0, False
                for span in line["spans"]:
                    parts.append(span["text"])
                    if span["size"] > max_size:
                        max_size = span["size"]
                    if "bold" in span["font"].lower() or span["flags"] & 16:
                        is_bold = True

                title = clean_text(" ".join(parts))
                if not title or not looks_like_heading(title):
                    continue

                level = size_to_level.get(round(max_size, 1))
                if level is None and is_bold:
                    level = max_known_level + 1

                if level is not None:
                    key = title.lower()
                    if key not in seen:
                        seen.add(key)
                        headings.append({"level": level, "title": title, "page": page_num + 1})

    return headings


def _get_font_freq(doc: fitz.Document, max_pages: int = 40) -> dict:
    freq: dict[float, int] = defaultdict(int)
    for page_num in range(min(len(doc), max_pages)):
        try:
            blocks = doc[page_num].get_text("dict")["blocks"]
        except Exception:
            continue
        for block in blocks:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    size = round(span["size"], 1)
                    freq[size] += len(span["text"].strip().split())
    return freq


def _heading_size_levels(freq: dict) -> dict[float, int]:
    if not freq:
        return {}
    body_size = max(freq, key=freq.get)
    larger = sorted([s for s in freq if s > body_size * 1.05], reverse=True)
    return {size: (i + 1) for i, size in enumerate(larger)}