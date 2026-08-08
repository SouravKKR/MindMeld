"""
ContentGuardrailRedactor

Removes the sentences an adjudication marked abusive, from ONE segment of text.
JSON structure is not its problem — GuardedTextDocument has already split a
structured response into its string values, so whatever arrives here is prose.
What can still arrive is HTML, because generated study material is HTML held
inside one such value.

That leaves two things to get right:

  - A removal must not start or end inside a tag. The scanner already stops a
    sentence at < or >, but a span can still straddle one when the sentence
    search ran out of room first, so the span is clamped inward to the nearest
    tag boundary around the match.
  - Overlapping spans (two flagged terms in one sentence) must be merged, then
    applied right to left so each cut leaves the offsets to its left valid.
"""

from Globals.Classes.Compliance.BannedTermMatch import BannedTermMatch


class ContentGuardrailRedactor:

    # There is deliberately no whole-segment tidy pass here. An earlier version
    # ran "collapse repeated spaces / drop empty bracket pairs / close the gap
    # before punctuation" over the finished text, and it silently rewrote content
    # the redaction had never touched: `int values[] = {1, 2, 3};` lost its `[]`,
    # `malloc()` lost its `()`, indented lines inside <pre> lost their indent, and
    # markdown checkboxes lost their box. Removing one sentence must not reformat
    # the rest of a study material. Spacing at the cut is handled by extending the
    # span itself, which touches nothing outside it.

    @staticmethod
    def remove(segment_text: str, matches_to_remove: list[BannedTermMatch]) -> tuple[str, bool]:
        """
        Returns (redacted_text, b_removed_anything). Never raises: on any
        unexpected failure the segment comes back untouched with False, so a
        redaction bug degrades to "did not redact" rather than to a corrupted
        response.
        """
        if not segment_text or not matches_to_remove:
            return (segment_text, False)

        try:
            b_contains_markup = "<" in segment_text and ">" in segment_text

            removal_spans = []
            for match in matches_to_remove:
                removal_spans.append(ContentGuardrailRedactor.__resolve_removal_span(
                    segment_text,
                    match,
                    b_contains_markup,
                ))

            merged_spans = ContentGuardrailRedactor.__merge_spans(removal_spans)
            if not merged_spans:
                return (segment_text, False)

            redacted_text = segment_text

            # Right to left: every cut leaves the offsets of everything before it
            # unchanged, so no index arithmetic is needed between passes.
            for start_index, end_index in reversed(merged_spans):
                redacted_text = redacted_text[:start_index] + redacted_text[end_index:]

            return (redacted_text, True)

        except Exception as redaction_error:
            print(f"[ContentGuardrailRedactor] Redaction failed, keeping the original segment: {redaction_error}")
            return (segment_text, False)

    @staticmethod
    def __resolve_removal_span(segment_text: str, match: BannedTermMatch, b_contains_markup: bool) -> tuple[int, int]:
        sentence_start_index, sentence_end_index = match.get_sentence_span()

        if b_contains_markup:
            sentence_start_index, sentence_end_index = ContentGuardrailRedactor.__clamp_inside_tags(
                segment_text,
                sentence_start_index,
                sentence_end_index,
                match.get_start_index(),
                match.get_end_index(),
            )

        return (sentence_start_index, ContentGuardrailRedactor.__extend_over_trailing_spaces(segment_text, sentence_end_index))

    @staticmethod
    def __extend_over_trailing_spaces(segment_text: str, sentence_end_index: int) -> int:
        """
        Swallows the spaces that separated the removed sentence from the next one.
        Without this, removing the first sentence of a paragraph leaves it
        starting with a space, and removing a middle one leaves a double gap.

        Only spaces and tabs. A newline is structural in markdown and in the
        generated HTML, so consuming it would join two lines that were meant to
        stay apart.
        """
        text_length = len(segment_text)

        while sentence_end_index < text_length and segment_text[sentence_end_index] in " \t":
            sentence_end_index += 1

        return sentence_end_index

    @staticmethod
    def __clamp_inside_tags(
        segment_text: str,
        sentence_start_index: int,
        sentence_end_index: int,
        match_start_index: int,
        match_end_index: int,
    ) -> tuple[int, int]:
        """
        Pulls a removal span inward so it stays within one HTML text node:
        starting just after the last '>' before the match and ending just before
        the first '<' after it guarantees no tag is half-deleted.
        """
        leading_text = segment_text[sentence_start_index:match_start_index]
        last_tag_end_offset = leading_text.rfind(">")
        if last_tag_end_offset != -1:
            sentence_start_index = sentence_start_index + last_tag_end_offset + 1

        trailing_text = segment_text[match_end_index:sentence_end_index]
        first_tag_start_offset = trailing_text.find("<")
        if first_tag_start_offset != -1:
            sentence_end_index = match_end_index + first_tag_start_offset

        # Clamping must never invert the span or cut into the match itself.
        sentence_start_index = min(sentence_start_index, match_start_index)
        sentence_end_index = max(sentence_end_index, match_end_index)

        return (sentence_start_index, sentence_end_index)

    @staticmethod
    def __merge_spans(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
        # Two matches in one sentence produce two identical spans; applying both
        # would delete the region twice and corrupt everything around it.
        ordered_spans = sorted(span for span in spans if span[1] > span[0])

        if not ordered_spans:
            return []

        merged_spans = [ordered_spans[0]]

        for start_index, end_index in ordered_spans[1:]:
            last_start_index, last_end_index = merged_spans[-1]

            if start_index <= last_end_index:
                merged_spans[-1] = (last_start_index, max(last_end_index, end_index))
            else:
                merged_spans.append((start_index, end_index))

        return merged_spans
