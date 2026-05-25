from typing import List
from Globals.Classes.Decorators.PageRange import PageRange


def is_full_document_range(page_range: PageRange) -> bool:
    """
    Returns True when a single PageRange is the (0, 0) sentinel that
    callers use to mean "the entire document".

    Lives here instead of on PageRange itself because PageRange is
    codegen'd from Common/Classes/PageRange.json and gets overwritten
    on every setup.bat run, so any method added to the class file
    silently disappears on the next codegen.
    """
    return page_range.get_start_page() == 0 and page_range.get_end_page() == 0


def expand_page_ranges(page_ranges: List[PageRange], total_pages: int) -> List[int]:
    """
    Expands a list of PageRange objects into a sorted, deduplicated list of
    1-indexed page numbers, clamped to [1, total_pages].

    Empty list OR any entry of {0,0} means "the full document".
    Overlapping ranges are unioned automatically by the set.
    """
    if total_pages <= 0:
        return []

    if not page_ranges:
        return list(range(1, total_pages + 1))

    for page_range in page_ranges:
        if is_full_document_range(page_range):
            return list(range(1, total_pages + 1))

    page_numbers = set()
    for page_range in page_ranges:
        start = max(1, min(total_pages, page_range.get_start_page()))
        end   = max(1, min(total_pages, page_range.get_end_page()))

        if start > end:
            start, end = end, start

        for page_number in range(start, end + 1):
            page_numbers.add(page_number)

    return sorted(page_numbers)


def is_full_document(page_ranges: List[PageRange]) -> bool:
    """
    Returns True when the page_ranges list signifies the entire document.
    """
    if not page_ranges:
        return True
    return any(is_full_document_range(page_range) for page_range in page_ranges)
