class SyllabusPlausibilityCheck:
    """
    Cheap structural check that an upload declared as CURRICULUM_OR_SYLLABUS is
    actually a syllabus rather than a textbook wearing a syllabus label.

    Why it exists. The paid-deck generation mode restricts uploads to
    CURRICULUM_OR_SYLLABUS so that content the platform sells demonstrably never
    had third-party expression to work from. But the source type is
    CLIENT-DECLARED metadata — a request can attach a 600-page textbook and call
    it a syllabus. Without this check the restriction is evidence of intent but
    not proof of fact; with it, the pipeline structurally could not have ingested
    a textbook under that label.

    What it does NOT do. It is not a plagiarism detector, a copyright classifier,
    or a content filter. It answers one narrow, deterministic question — "does
    this document have the SHAPE of a curriculum outline?" — from page count and
    line-length distribution. No model is involved, so the answer is stable and
    explainable, and a rejection can be stated to the uploader as a reason rather
    than a verdict.

    Calibration. Both thresholds are deliberately generous, because a false
    rejection blocks a legitimate upload while a false acceptance is caught later
    by coverage reconciliation and the review gate. A real syllabus is a list of
    topics: many short lines, few pages. A textbook is body prose: long wrapped
    lines, many pages. Only an egregious page count rejects on its own; the prose
    signal must be corroborated by size before it rejects anything.
    """

    # A curriculum document longer than this is not a syllabus by any reasonable
    # reading. Multi-subject national curricula run to a few dozen pages; the
    # ceiling sits well above that so a genuinely long official syllabus passes.
    MAXIMUM_SYLLABUS_PAGE_COUNT = 80

    # The prose signal is meaningless on a short document — a 6-page syllabus with
    # descriptive unit paragraphs is still a syllabus. It only becomes evidence
    # once the document is also substantial.
    PROSE_CHECK_MINIMUM_PAGE_COUNT = 25

    # A line of this many words or more reads as body prose rather than a topic
    # entry. Topic lines ("3.2 Refraction at a spherical surface") run to about
    # half a dozen words; a wrapped line of body text in a single-column book at
    # a normal size runs to twelve or more. Calibrated against rendered line
    # length rather than sentence length — this counts LINES, not sentences, so
    # a threshold set at sentence scale would never fire at all.
    PROSE_LINE_MINIMUM_WORD_COUNT = 12

    # Fraction of non-empty lines that must be prose-length before the document is
    # judged to be prose rather than an outline.
    MAXIMUM_PROSE_LINE_RATIO = 0.55

    # Pages sampled for the prose measurement. Front matter is skipped because a
    # syllabus and a textbook both open with a preface, and sampling the whole
    # document would make the check cost scale with the very files it rejects.
    PROSE_SAMPLE_PAGE_COUNT = 12
    PROSE_SAMPLE_SKIP_LEADING_PAGES = 3

    # Below this, the sample carries no signal (an image-only or near-empty
    # document) and the check declines to judge rather than guessing.
    MINIMUM_SAMPLED_LINE_COUNT = 40

    @staticmethod
    def evaluate(pdf_bytes: bytes) -> dict:
        """
        Returns {"plausible": bool, "reason": str|None, "pageCount": int,
        "proseLineRatio": float|None}.

        Never raises for a malformed or unreadable PDF: an unparseable document
        is not evidence of a textbook, and failing the upload on a parser quirk
        would be a worse outcome than accepting it. Those cases return plausible.
        """
        import fitz

        try:
            pdf_document = fitz.open(stream = pdf_bytes, filetype = "pdf")
        except Exception as open_error:
            print(f"[SyllabusPlausibilityCheck] Could not open the PDF ({open_error}) — declining to judge.")
            return {"plausible": True, "reason": None, "pageCount": 0, "proseLineRatio": None}

        try:
            page_count = pdf_document.page_count

            if page_count > SyllabusPlausibilityCheck.MAXIMUM_SYLLABUS_PAGE_COUNT:
                return {
                    "plausible": False,
                    "reason": (
                        f"This document has {page_count} pages. A curriculum or syllabus is a list of "
                        f"topics, not a full text — anything over "
                        f"{SyllabusPlausibilityCheck.MAXIMUM_SYLLABUS_PAGE_COUNT} pages is almost "
                        f"certainly a textbook or study guide. Upload the syllabus itself, or select "
                        f"\"Provided documents\" as the source type instead."
                    ),
                    "pageCount": page_count,
                    "proseLineRatio": None,
                }

            if page_count < SyllabusPlausibilityCheck.PROSE_CHECK_MINIMUM_PAGE_COUNT:
                return {"plausible": True, "reason": None, "pageCount": page_count, "proseLineRatio": None}

            prose_line_ratio = SyllabusPlausibilityCheck.__measure_prose_line_ratio(pdf_document, page_count)

            if prose_line_ratio is None:
                return {"plausible": True, "reason": None, "pageCount": page_count, "proseLineRatio": None}

            if prose_line_ratio > SyllabusPlausibilityCheck.MAXIMUM_PROSE_LINE_RATIO:
                return {
                    "plausible": False,
                    "reason": (
                        f"This document is {page_count} pages of continuous prose "
                        f"({round(prose_line_ratio * 100)}% of its lines are full sentences rather than "
                        f"topic entries), which reads as a textbook rather than a syllabus. Upload the "
                        f"syllabus itself, or select \"Provided documents\" as the source type instead."
                    ),
                    "pageCount": page_count,
                    "proseLineRatio": prose_line_ratio,
                }

            return {"plausible": True, "reason": None, "pageCount": page_count, "proseLineRatio": prose_line_ratio}
        finally:
            pdf_document.close()

    @staticmethod
    def __measure_prose_line_ratio(pdf_document, page_count: int) -> float | None:
        """
        Fraction of sampled non-empty lines that are prose-length. Returns None
        when the sample is too thin to mean anything (scanned pages with no text
        layer, a mostly-graphical document).
        """
        first_sampled_page = min(SyllabusPlausibilityCheck.PROSE_SAMPLE_SKIP_LEADING_PAGES, max(0, page_count - 1))
        last_sampled_page = min(page_count, first_sampled_page + SyllabusPlausibilityCheck.PROSE_SAMPLE_PAGE_COUNT)

        total_line_count = 0
        prose_line_count = 0

        for page_index in range(first_sampled_page, last_sampled_page):
            try:
                page_text = pdf_document.load_page(page_index).get_text("text")
            except Exception:
                continue

            for line in page_text.splitlines():
                stripped_line = line.strip()
                if not stripped_line:
                    continue
                total_line_count += 1
                if len(stripped_line.split()) >= SyllabusPlausibilityCheck.PROSE_LINE_MINIMUM_WORD_COUNT:
                    prose_line_count += 1

        if total_line_count < SyllabusPlausibilityCheck.MINIMUM_SAMPLED_LINE_COUNT:
            return None

        return prose_line_count / total_line_count
