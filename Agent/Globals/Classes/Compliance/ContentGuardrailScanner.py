"""
ContentGuardrailScanner

Turns a piece of model-generated text into a list of BannedTermMatch. This is the
stage that runs on EVERY response, so everything here is sized to be cheap:

  - One pass of the compiled lexicon pattern. No tokenising, no splitting, no
    normalising beyond a single str.lower().
  - The context window and the sentence bounds are derived from a bounded slice
    around each match, and only after a match exists. A clean response never
    touches anything but the one regex pass.

The scanner also owns the lowercase contract described in BannedTermLexicon:
match offsets index the ORIGINAL text, because the redactor slices with them.
"""

import re

from Globals.Classes.Compliance.BannedTermLexicon import BannedTermLexicon
from Globals.Classes.Compliance.BannedTermMatch import BannedTermMatch


class ContentGuardrailScanner:

    # How much text either side of a match the verification model is shown. The
    # figure comes from the feature request; it is wide enough to carry a quoting
    # or citing frame ("the witness testified that he called her a ...") that a
    # single sentence would cut off.
    WORDS_OF_CONTEXT_EACH_SIDE = 25

    # Upper bound on characters per word, used only to size the slice that gets
    # tokenised for the context window. English averages around six characters
    # per word including the space, so thirty is a five-fold margin and the slice
    # never truncates the window on realistically long technical vocabulary.
    MAXIMUM_CHARACTERS_PER_WORD = 30

    # How far the sentence search walks in each direction before giving up and
    # using the bound it reached. Generated HTML can contain a single paragraph
    # far longer than a sentence, and an unbounded search would turn a per-match
    # cost into a per-document one.
    MAXIMUM_SENTENCE_SCAN_CHARACTERS = 1500

    # A sentence ends at one of these followed by whitespace or end-of-text. The
    # "followed by whitespace" rule is what keeps "3.14" and "10.5%" from being
    # read as sentence ends. Abbreviations ("e.g. the") do split early, which is
    # the safe direction: an early split removes LESS text, never more.
    SENTENCE_TERMINATOR_CHARACTERS = ".!?"

    # Treated as hard sentence bounds regardless of what follows. A newline ends
    # a line of generated markdown, and the angle brackets keep a removal from
    # starting or ending in the middle of an HTML tag.
    HARD_BOUNDARY_BEFORE_CHARACTERS = "\n\r>"
    HARD_BOUNDARY_AFTER_CHARACTERS = "\n\r<"

    __WORD_PATTERN = re.compile(r"\S+")

    # Mirrors BannedTermLexicon.SPACE_REPLACEMENT_PATTERN. Used to fold a matched
    # multi-word term back to the single-spaced form the word list stores.
    __SEPARATOR_RUN_PATTERN = re.compile(r"[\s\-]+")

    @staticmethod
    def scan(text: str) -> list[BannedTermMatch]:
        """
        Every banned term in `text`, left to right, non-overlapping. Returns an
        empty list for empty input, a missing word list, or a clean response.
        Never raises.
        """
        if not text or not isinstance(text, str):
            return []

        search_text, pattern = ContentGuardrailScanner.__resolve_search_text_and_pattern(text)

        if pattern is None:
            return []

        collected_matches = []

        for regex_match in pattern.finditer(search_text):
            start_index = regex_match.start()
            end_index = regex_match.end()

            sentence_start_index, sentence_end_index = ContentGuardrailScanner.__find_sentence_bounds(
                text,
                start_index,
                end_index,
            )

            collected_matches.append(BannedTermMatch(
                # Canonicalised back to the list entry it came from. A multi-word
                # entry matches its separator as a run, so "hand\njob" and
                # "hand-job" are both the entry "hand job" — and the logs, the
                # adjudicator prompt and any grouping all want the entry, not the
                # incidental whitespace the model happened to emit.
                term = ContentGuardrailScanner.__SEPARATOR_RUN_PATTERN.sub(
                    " ",
                    search_text[start_index:end_index].lower(),
                ),
                matched_text = text[start_index:end_index],
                start_index = start_index,
                end_index = end_index,
                sentence_start_index = sentence_start_index,
                sentence_end_index = sentence_end_index,
                context_snippet = ContentGuardrailScanner.__extract_context_snippet(text, start_index, end_index),
            ))

        return collected_matches

    @staticmethod
    def contains_banned_term(text: str) -> bool:
        """
        Detection only, skipping the window and sentence work. Used by the
        streaming adapter, which asks this question once per completed sentence
        and only needs the full match objects on the rare sentence that trips.
        """
        if not text or not isinstance(text, str):
            return False

        search_text, pattern = ContentGuardrailScanner.__resolve_search_text_and_pattern(text)

        if pattern is None:
            return False

        return pattern.search(search_text) is not None

    @staticmethod
    def __resolve_search_text_and_pattern(text: str) -> tuple[str, "re.Pattern | None"]:
        """
        Picks the fast path where it is sound. Lowercasing lets the scan use the
        case-sensitive pattern, which is 2.2x cheaper than IGNORECASE — but only
        while offsets still line up with the original string.

        Unicode lowercase mappings never contract, so an unchanged length proves
        no character expanded and the mapping is 1:1. The one realistic expander
        is U+0130 (capital I with dot above); a string containing it falls back to
        matching the original text under IGNORECASE.
        """
        lowered_text = text.lower()

        if len(lowered_text) == len(text):
            return (lowered_text, BannedTermLexicon.get_lowercase_pattern())

        return (text, BannedTermLexicon.get_case_insensitive_pattern())

    @staticmethod
    def __find_sentence_bounds(text: str, start_index: int, end_index: int) -> tuple[int, int]:
        """
        The span of the sentence containing [start_index, end_index), clamped to
        MAXIMUM_SENTENCE_SCAN_CHARACTERS in each direction.
        """
        return (
            ContentGuardrailScanner.__find_sentence_start(text, start_index),
            ContentGuardrailScanner.__find_sentence_end(text, end_index),
        )

    @staticmethod
    def __find_sentence_start(text: str, start_index: int) -> int:
        scan_limit = max(0, start_index - ContentGuardrailScanner.MAXIMUM_SENTENCE_SCAN_CHARACTERS)
        sentence_start_index = scan_limit
        cursor = start_index - 1

        while cursor >= scan_limit:
            character = text[cursor]

            if character in ContentGuardrailScanner.HARD_BOUNDARY_BEFORE_CHARACTERS:
                sentence_start_index = cursor + 1
                break

            # A terminator only ends the previous sentence when whitespace
            # follows it, so decimals and version numbers are not boundaries.
            b_is_terminator = character in ContentGuardrailScanner.SENTENCE_TERMINATOR_CHARACTERS
            if b_is_terminator and cursor + 1 < len(text) and text[cursor + 1].isspace():
                sentence_start_index = cursor + 1
                break

            cursor -= 1

        # Step over the whitespace that separated the two sentences so the
        # removal does not leave a leading gap behind.
        while sentence_start_index < start_index and text[sentence_start_index].isspace():
            sentence_start_index += 1

        return sentence_start_index

    @staticmethod
    def __find_sentence_end(text: str, end_index: int) -> int:
        text_length = len(text)
        scan_limit = min(text_length, end_index + ContentGuardrailScanner.MAXIMUM_SENTENCE_SCAN_CHARACTERS)
        cursor = end_index

        while cursor < scan_limit:
            character = text[cursor]

            if character in ContentGuardrailScanner.HARD_BOUNDARY_AFTER_CHARACTERS:
                return cursor

            if character in ContentGuardrailScanner.SENTENCE_TERMINATOR_CHARACTERS:
                b_at_text_end = cursor + 1 >= text_length
                if b_at_text_end or text[cursor + 1].isspace():
                    # Include the terminator itself.
                    return cursor + 1

            cursor += 1

        return scan_limit

    @staticmethod
    def __extract_context_snippet(text: str, start_index: int, end_index: int) -> str:
        """
        The +/- 25 word window around the match, taken from a bounded slice so the
        cost is fixed per match rather than proportional to the document.

        Word positions are located, then the ORIGINAL text between them is sliced
        out verbatim. Re-joining the tokens with single spaces would be the
        obvious alternative, but it detaches punctuation ("Bitch!" comes back as
        "Bitch !") and flattens the line breaks that tell the verification model
        where a heading ended and a quotation began.
        """
        window_characters = (
            ContentGuardrailScanner.WORDS_OF_CONTEXT_EACH_SIDE
            * ContentGuardrailScanner.MAXIMUM_CHARACTERS_PER_WORD
        )

        slice_start = max(0, start_index - window_characters)
        slice_end = min(len(text), end_index + window_characters)

        context_start_index = ContentGuardrailScanner.__find_word_boundary_before(
            text[slice_start:start_index],
            slice_start,
            b_slice_was_cut = slice_start > 0,
            fallback_index = start_index,
        )
        context_end_index = ContentGuardrailScanner.__find_word_boundary_after(
            text[end_index:slice_end],
            end_index,
            b_slice_was_cut = slice_end < len(text),
            fallback_index = end_index,
        )

        return text[context_start_index:context_end_index].strip()

    @staticmethod
    def __find_word_boundary_before(text_slice: str, slice_offset: int, b_slice_was_cut: bool, fallback_index: int) -> int:
        words = list(ContentGuardrailScanner.__WORD_PATTERN.finditer(text_slice))

        # The slice was cut at a fixed character offset, so the token touching the
        # cut may be half a word. Dropping it costs one word of context and keeps
        # the snippet readable.
        if b_slice_was_cut and words:
            words = words[1:]

        if not words:
            return fallback_index

        selected_words = words[-ContentGuardrailScanner.WORDS_OF_CONTEXT_EACH_SIDE:]

        return slice_offset + selected_words[0].start()

    @staticmethod
    def __find_word_boundary_after(text_slice: str, slice_offset: int, b_slice_was_cut: bool, fallback_index: int) -> int:
        words = list(ContentGuardrailScanner.__WORD_PATTERN.finditer(text_slice))

        if b_slice_was_cut and words:
            words = words[:-1]

        if not words:
            return fallback_index

        selected_words = words[:ContentGuardrailScanner.WORDS_OF_CONTEXT_EACH_SIDE]

        return slice_offset + selected_words[-1].end()
