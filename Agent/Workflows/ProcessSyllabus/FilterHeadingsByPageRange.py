import re
import difflib

from Globals.Classes.Pdf.PdfDocumentReader import PdfDocumentReader
from Workflows.ProcessSyllabus.TextbookExtractionUtils import clean_text, looks_like_heading


# A heading is considered "found in range" if the best fuzzy match against
# any heading-like line in the page range scores at or above this threshold.
_FUZZY_THRESHOLD = 0.60


def filter_headings_by_page_range(
    pdf_reader: PdfDocumentReader,
    headings: list[dict],
    start_page: int,
    end_page: int,
) -> list[dict]:
    """
    Given a full list of headings (e.g. from the TOC or font heuristics),
    return only those that actually appear in the PDF pages [start_page, end_page]
    (1-indexed, inclusive).

    Strategy:
      1. Scan every page in the range and collect all heading-like lines
         found in the actual content.
      2. For each TOC/font heading, fuzzy-match its title against every
         collected line. If the best match ratio >= _FUZZY_THRESHOLD the
         heading is considered present in the range and is kept.

    Fuzzy matching handles LLM-refined topic names that differ slightly
    from what is literally printed in the PDF.
    """
    if not headings:
        return []

    # Convert to 0-indexed page indices
    first_page_index = max(0, start_page - 1)
    end_page_index   = min(pdf_reader.get_page_count(), end_page)   # exclusive upper bound for range()

    candidate_lines = _collect_heading_lines(pdf_reader, first_page_index, end_page_index)

    if not candidate_lines:
        # Nothing heading-like found on those pages — return everything rather
        # than returning nothing (fail-open is safer for content recall)
        return headings

    kept = []
    for heading in headings:
        if _is_present(heading["title"], candidate_lines):
            kept.append(heading)

    return kept if kept else headings   # fail-open: never return empty


def _collect_heading_lines(
    pdf_reader: PdfDocumentReader,
    first_page_index: int,
    end_page_index: int,
) -> list[str]:
    """
    Collect every short, heading-like line of text from the page range.
    We cast a wide net here — false positives are fine because we only use
    these lines as a matching corpus, not as the final output.
    """
    lines = []
    for page_index in range(first_page_index, end_page_index):
        page_text = pdf_reader.get_page_text(page_index)
        if not page_text:
            continue
        for raw_line in page_text.splitlines():
            line = clean_text(raw_line)
            # Deliberately relaxed: accept anything between 3 and 200 chars
            # that isn't pure digits/punctuation
            if 3 <= len(line) <= 200 and not re.fullmatch(r"[\d\s\.\-,;:]+", line):
                lines.append(line.lower())
    return lines


def _is_present(title: str, candidate_lines: list[str]) -> bool:
    """
    Return True if `title` fuzzy-matches any line in `candidate_lines`
    at or above _FUZZY_THRESHOLD.
    """
    needle = title.lower()
    # get_close_matches is fast for small corpora; if the corpus is large
    # we still only care about the top-1 match
    matches = difflib.get_close_matches(needle, candidate_lines, n=1, cutoff=_FUZZY_THRESHOLD)
    if matches:
        return True

    # Secondary check: substring containment for very short headings
    # e.g. "RAID" will appear inside longer lines
    for line in candidate_lines:
        if needle in line:
            return True

    return False