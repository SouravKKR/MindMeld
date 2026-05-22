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
    except Exception as e:
        print(f"  [WARN] Page {page.number + 1} unreadable — {type(e).__name__}: {e}")
        return ""


def _safe_page_dict(page: fitz.Page) -> list:
    try:
        return page.get_text("dict")["blocks"]
    except Exception as e:
        print(f"  [WARN] Page {page.number + 1} dict unreadable — {type(e).__name__}: {e}")
        return []


def extract_text_via_bookmarks(doc: fitz.Document, start_page: int, end_page: int) -> str | None:
    """
    Tier 1 — Uses the embedded TOC to walk the PDF in reading order.
    Injects heading markers so nearby chunks carry topic context.
    Only processes pages within [start_page, end_page] (1-indexed, inclusive).
    Returns full text or None if no TOC exists.
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

    entries.sort(key=lambda x: x[0])

    pageToHeadings: dict[int, list[str]] = defaultdict(list)
    for pageNum, title in entries:
        pageToHeadings[pageNum].append(title)

    parts = []
    for pageNum in range(first_page_index, last_page_index + 1):
        for heading in pageToHeadings.get(pageNum, []):
            parts.append(f"\n=== {heading} ===\n")
        text = _safe_page_text(doc[pageNum])
        if text:
            parts.append(text)

    result = "\n".join(parts)
    print(f"[Tier 1] Bookmark-ordered text extracted (pages {start_page}–{end_page}, {len(result):,} chars).")
    return result if result.strip() else None


def extract_text_via_font_heuristics(doc: fitz.Document, start_page: int, end_page: int) -> str | None:
    """
    Tier 2 — Detects headings by font size and injects them as section markers.
    Only processes pages within [start_page, end_page] (1-indexed, inclusive).
    Returns full text or None if too few headings are found.
    """
    first_page_index = start_page - 1
    last_page_index  = end_page - 1

    freq: dict[float, int] = defaultdict(int)
    sample_end = min(last_page_index + 1, first_page_index + 40)
    for page_num in range(first_page_index, sample_end):
        for block in _safe_page_dict(doc[page_num]):
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    size = round(span["size"], 1)
                    freq[size] += len(span["text"].strip().split())

    if not freq:
        return None

    bodySize     = max(freq, key=freq.get)
    headingSizes = {round(s, 1) for s in freq if s > bodySize * 1.05}

    parts: list[str] = []
    seen_headings: set[str] = set()
    headingCount = 0

    for pageNum in range(first_page_index, last_page_index + 1):
        pageText = _safe_page_text(doc[pageNum])
        if not pageText:
            continue

        for block in _safe_page_dict(doc[pageNum]):
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                lineText, maxSize, isBold = [], 0.0, False
                for span in line["spans"]:
                    lineText.append(span["text"])
                    if span["size"] > maxSize:
                        maxSize = span["size"]
                    if "bold" in span["font"].lower() or span["flags"] & 16:
                        isBold = True

                title = _clean_text(" ".join(lineText))
                if not title or not _looks_like_heading(title):
                    continue
                if round(maxSize, 1) not in headingSizes and not isBold:
                    continue
                if title.lower() not in seen_headings:
                    seen_headings.add(title.lower())
                    parts.append(f"\n=== {title} ===\n")
                    headingCount += 1

        parts.append(pageText)

    if headingCount < 3:
        print(f"[Tier 2] Only {headingCount} headings detected — insufficient.")
        return None

    result = "\n".join(parts)
    print(f"[Tier 2] Font-heuristic text extracted (pages {start_page}–{end_page}, {headingCount} headings, {len(result):,} chars).")
    return result if result.strip() else None


def extract_text_raw(doc: fitz.Document, start_page: int, end_page: int) -> str:
    """Tier 3 — Plain page-by-page dump within [start_page, end_page]. Always succeeds."""
    first_page_index = start_page - 1
    last_page_index  = end_page - 1

    parts = []
    for pageNum in range(first_page_index, last_page_index + 1):
        text = _safe_page_text(doc[pageNum])
        if text:
            parts.append(text)
    result = "\n".join(parts)
    print(f"[Tier 3] Raw text dump (pages {start_page}–{end_page}, {len(result):,} chars).")
    return result


def extract_text(pdf_bytes: bytes, start_page: int = 1, end_page: int | None = None) -> str:
    """
    Master entry point. Accepts raw PDF bytes and an optional 1-indexed page range.
    If end_page is None the full document is used.
    Tries Tier 1 → Tier 2 → Tier 3 and returns the best result.
    """
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")

    clamped_start = max(1, start_page)
    clamped_end   = min(doc.page_count, end_page) if end_page is not None else doc.page_count

    if clamped_start > clamped_end:
        print(f"[ExtractText] Invalid page range ({clamped_start}–{clamped_end}) — falling back to full document.")
        clamped_start = 1
        clamped_end   = doc.page_count

    print(f"[ExtractText] Processing pages {clamped_start}–{clamped_end} of {doc.page_count}.")

    fullText = extract_text_via_bookmarks(doc, clamped_start, clamped_end)
    if not fullText:
        fullText = extract_text_via_font_heuristics(doc, clamped_start, clamped_end)
    if not fullText:
        fullText = extract_text_raw(doc, clamped_start, clamped_end)

    doc.close()
    return fullText or ""