import re
import unicodedata
from collections import defaultdict

import fitz


def _clean_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return re.sub(r"\s+", " ", text).strip()


def _looks_like_heading(text: str) -> bool:
    t = text.strip()
    if len(t) < 3 or len(t) > 160:
        return False
    if re.fullmatch(r"[\d\s\.\-]+", t):
        return False
    if t.endswith((".", ",", ";", "?")) and len(t.split()) > 10:
        return False
    return True


def _safe_page_text(page: fitz.Page) -> str:
    try:
        return page.get_text() or ""
    except Exception as page_text_error:
        print(f"  [WARN] Page {page.number + 1} unreadable — {type(page_text_error).__name__}: {page_text_error}")
        return ""


def _safe_page_dict(page: fitz.Page) -> list:
    try:
        return page.get_text("dict")["blocks"]
    except Exception as page_dict_error:
        print(f"  [WARN] Page {page.number + 1} dict unreadable — {type(page_dict_error).__name__}: {page_dict_error}")
        return []


def _join_parts_with_page_spans(parts: list, page_part_starts: list) -> tuple[str, list]:
    """
    Joins text parts with newlines (matching the historical "\n".join behaviour)
    while resolving the character offset at which each page's text begins.

    page_part_starts is a list of (part_index, page_index) pairs recorded as the
    parts list was built. The returned page_spans is a list of
    (character_offset, page_index) pairs aligned to the joined string — these let
    downstream chunking attribute each character offset back to its source page.
    page_index is 0-indexed to match the figure pageNumber produced by the image
    extractor.
    """
    part_offsets = []
    running_length = 0
    for part_index, part_text in enumerate(parts):
        if part_index > 0:
            running_length += 1  # the newline inserted by the join
        part_offsets.append(running_length)
        running_length += len(part_text)

    joined_text = "\n".join(parts)

    page_spans = []
    for part_index, page_index in page_part_starts:
        character_offset = part_offsets[part_index] if part_index < len(part_offsets) else len(joined_text)
        page_spans.append((character_offset, page_index))

    return joined_text, page_spans


def extract_text_via_bookmarks(doc: fitz.Document, start_page: int, end_page: int) -> tuple[str, list] | None:
    """
    Tier 1 — Uses the embedded TOC to walk the PDF in reading order.
    Injects heading markers so nearby chunks carry topic context.
    Only processes pages within [start_page, end_page] (1-indexed, inclusive).
    Returns (text, page_spans) or None if no TOC exists.
    """
    raw_toc = doc.get_toc(simple=False)
    if not raw_toc:
        return None

    # Convert to 0-indexed bounds for internal use
    first_page_index = start_page - 1
    last_page_index  = end_page - 1

    entries = []
    for item in raw_toc:
        level, title, page = item[0], item[1], item[2]
        title = _clean_text(title)
        page_index = max(page - 1, 0)
        if title and first_page_index <= page_index <= last_page_index:
            entries.append((page_index, title))

    entries.sort(key=lambda entry: entry[0])

    headings_by_page: dict[int, list[str]] = defaultdict(list)
    for page_number, title in entries:
        headings_by_page[page_number].append(title)

    parts = []
    page_part_starts = []
    for page_number in range(first_page_index, last_page_index + 1):
        page_part_starts.append((len(parts), page_number))
        for heading in headings_by_page.get(page_number, []):
            parts.append(f"\n=== {heading} ===\n")
        text = _safe_page_text(doc[page_number])
        if text:
            parts.append(text)

    result, page_spans = _join_parts_with_page_spans(parts, page_part_starts)
    print(f"[Tier 1] Bookmark-ordered text extracted (pages {start_page}–{end_page}, {len(result):,} chars).")
    return (result, page_spans) if result.strip() else None


def extract_text_via_font_heuristics(doc: fitz.Document, start_page: int, end_page: int) -> tuple[str, list] | None:
    """
    Tier 2 — Detects headings by font size and injects them as section markers.
    Only processes pages within [start_page, end_page] (1-indexed, inclusive).
    Returns (text, page_spans) or None if too few headings are found.
    """
    first_page_index = start_page - 1
    last_page_index  = end_page - 1

    word_count_by_font_size: dict[float, int] = defaultdict(int)
    sample_end = min(last_page_index + 1, first_page_index + 40)
    for page_number in range(first_page_index, sample_end):
        for block in _safe_page_dict(doc[page_number]):
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    font_size = round(span["size"], 1)
                    word_count_by_font_size[font_size] += len(span["text"].strip().split())

    if not word_count_by_font_size:
        return None

    body_font_size = max(word_count_by_font_size, key=word_count_by_font_size.get)
    heading_font_sizes = {round(font_size, 1) for font_size in word_count_by_font_size if font_size > body_font_size * 1.05}

    parts: list[str] = []
    page_part_starts = []
    seen_headings: set[str] = set()
    heading_count = 0

    for page_number in range(first_page_index, last_page_index + 1):
        page_text = _safe_page_text(doc[page_number])
        if not page_text:
            continue

        page_part_starts.append((len(parts), page_number))

        for block in _safe_page_dict(doc[page_number]):
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                line_text, max_font_size, is_bold = [], 0.0, False
                for span in line["spans"]:
                    line_text.append(span["text"])
                    if span["size"] > max_font_size:
                        max_font_size = span["size"]
                    if "bold" in span["font"].lower() or span["flags"] & 16:
                        is_bold = True

                title = _clean_text(" ".join(line_text))
                if not title or not _looks_like_heading(title):
                    continue
                if round(max_font_size, 1) not in heading_font_sizes and not is_bold:
                    continue
                if title.lower() not in seen_headings:
                    seen_headings.add(title.lower())
                    parts.append(f"\n=== {title} ===\n")
                    heading_count += 1

        parts.append(page_text)

    if heading_count < 3:
        print(f"[Tier 2] Only {heading_count} headings detected — insufficient.")
        return None

    result, page_spans = _join_parts_with_page_spans(parts, page_part_starts)
    print(f"[Tier 2] Font-heuristic text extracted (pages {start_page}–{end_page}, {heading_count} headings, {len(result):,} chars).")
    return (result, page_spans) if result.strip() else None


def extract_text_raw(doc: fitz.Document, start_page: int, end_page: int) -> tuple[str, list]:
    """Tier 3 — Plain page-by-page dump within [start_page, end_page]. Always succeeds.
    Returns (text, page_spans)."""
    first_page_index = start_page - 1
    last_page_index  = end_page - 1

    parts = []
    page_part_starts = []
    for page_number in range(first_page_index, last_page_index + 1):
        text = _safe_page_text(doc[page_number])
        if text:
            page_part_starts.append((len(parts), page_number))
            parts.append(text)
    result, page_spans = _join_parts_with_page_spans(parts, page_part_starts)
    print(f"[Tier 3] Raw text dump (pages {start_page}–{end_page}, {len(result):,} chars).")
    return result, page_spans


def extract_text_with_page_map(pdf_bytes: bytes, start_page: int = 1, end_page: int | None = None) -> tuple[str, list]:
    """
    Master entry point that also reports page provenance. Accepts raw PDF bytes
    and an optional 1-indexed page range. If end_page is None the full document
    is used. Tries Tier 1 → Tier 2 → Tier 3 and returns the best result.

    Returns (text, page_spans) where page_spans is a list of
    (character_offset, page_index) pairs marking where each page's text begins
    in the returned string. page_index is 0-indexed to match the figure
    pageNumber produced by the image extractor.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    clamped_start = max(1, start_page)
    clamped_end   = min(doc.page_count, end_page) if end_page is not None else doc.page_count

    if clamped_start > clamped_end:
        print(f"[ExtractText] Invalid page range ({clamped_start}–{clamped_end}) — falling back to full document.")
        clamped_start = 1
        clamped_end   = doc.page_count

    print(f"[ExtractText] Processing pages {clamped_start}–{clamped_end} of {doc.page_count}.")

    extraction_result = extract_text_via_bookmarks(doc, clamped_start, clamped_end)
    if not extraction_result:
        extraction_result = extract_text_via_font_heuristics(doc, clamped_start, clamped_end)
    if not extraction_result:
        extraction_result = extract_text_raw(doc, clamped_start, clamped_end)

    doc.close()

    if not extraction_result:
        return "", []

    full_text, page_spans = extraction_result
    return full_text or "", page_spans


def extract_text(pdf_bytes: bytes, start_page: int = 1, end_page: int | None = None) -> str:
    """
    Thin wrapper over extract_text_with_page_map for callers that only need the
    extracted text and not its page provenance.
    """
    full_text, _ = extract_text_with_page_map(pdf_bytes, start_page=start_page, end_page=end_page)
    return full_text