import json
import re


class JsonReplyReader:
    """
    Turns a model's raw reply into a JSON value, or into nothing.

    A strict contract, which is the whole reason this exists alongside
    strip_json_markdown: read_object returns a dict or None. Never a string,
    never the literal "{}", never an exception. The older helper returns
    `dict | None | str("{}")` depending on the input, and that union is not a
    style complaint — an empty reply came back as the STRING "{}", every caller
    tested `isinstance(parsed, dict)`, and so "the model said nothing at all"
    was reported to the user as "the model returned an unusable response shape".
    Two very different failures, one message, and no way to tell them apart.

    strip_json_markdown was deliberately NOT changed. It has around thirty call
    sites across paid-deck generation, paid-deck verification, mock tests,
    syllabus processing and the content guardrail, and at least one of them
    already depends on a different contract than the others do. Redefining a
    helper that much of the product parses replies through, in order to fix one
    workflow, trades a known bug for an unknown number of them.

    The extraction is layered because models fail at this in layered ways: a
    bare object, a fenced object, a fence with a language label, an object with
    a sentence in front of it, and an object with a sentence in front of it AND
    a fence inside one of its string values. Each layer below exists because the
    layer above it demonstrably does not cover a shape this product receives.
    """

    # A language label on a fence's opening line — `json`, `JSON`, `jsonc`,
    # `js`, `html` have all been observed. Matched generically rather than as a
    # hardcoded pair, because the hardcoded pair is what let `jsonc` through
    # into json.loads to fail there.
    __LANGUAGE_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9_+.-]{1,12}$")

    __FENCE_MARKER = "```"

    @classmethod
    def read_object(cls, raw_text) -> dict | None:
        """
        The reply as a dict, or None. See the class comment for the contract.
        """
        parsed_value = cls.__read_value(raw_text)
        return parsed_value if isinstance(parsed_value, dict) else None

    @classmethod
    def read_list(cls, raw_text) -> list | None:
        """
        The reply as a list, or None. Present so a caller expecting an array
        never has to reach for the untyped reader and re-check the type itself.
        """
        parsed_value = cls.__read_value(raw_text)
        return parsed_value if isinstance(parsed_value, list) else None

    @classmethod
    def __read_value(cls, raw_text):
        if not isinstance(raw_text, str) or not raw_text.strip():
            return None

        candidate_bodies = [
            raw_text.strip(),
            cls.__strip_markdown_fence(raw_text),
            cls.__extract_balanced_span(raw_text, "{", "}"),
            cls.__extract_balanced_span(raw_text, "[", "]"),
        ]

        for candidate_body in candidate_bodies:
            if not candidate_body:
                continue

            try:
                return json.loads(candidate_body)
            except (json.JSONDecodeError, ValueError):
                continue

        return None

    @classmethod
    def __strip_markdown_fence(cls, raw_text: str) -> str | None:
        """
        The body of a fenced block.

        Located with find/rfind rather than split("```")[1]. The split takes
        everything up to the FIRST closing marker, which truncates the payload
        the moment the JSON contains a fence inside one of its string values —
        and a lesson about programming that quotes a code block is exactly that
        case, on the workflow that reads HTML back out of `revisedHtml`.

        An unterminated fence returns None rather than a guess. Half a fenced
        block is not a document, and treating it as one produces a parse error
        attributed to the model rather than to the truncation that caused it.
        """
        opening_index = raw_text.find(cls.__FENCE_MARKER)

        if opening_index == -1:
            return None

        opening_line_end_index = raw_text.find("\n", opening_index)

        if opening_line_end_index == -1:
            return None

        closing_index = raw_text.rfind(cls.__FENCE_MARKER)

        if closing_index <= opening_line_end_index:
            return None

        language_label = raw_text[opening_index + len(cls.__FENCE_MARKER):opening_line_end_index].strip()

        # A "label" that is not a plausible language token means the fence
        # opened mid-sentence; the body is still taken, but nothing is assumed
        # about that line.
        if language_label and not cls.__LANGUAGE_LABEL_PATTERN.match(language_label):
            return None

        return raw_text[opening_line_end_index + 1:closing_index].strip() or None

    @classmethod
    def __extract_balanced_span(cls, raw_text: str, opening_character: str, closing_character: str) -> str | None:
        """
        The first balanced {...} or [...] span, for a reply that wrapped its
        object in prose ("Here is the revision: {...} Let me know...").

        STRING STATE IS TRACKED, and that is not defensive programming — it is
        required. The values this reads are HTML, which routinely carries braces
        in inline styles, in KaTeX and in code samples, so a naive scan to the
        last closing character returns the wrong slice on precisely the payloads
        this workflow handles. Backslash escapes are honoured for the same
        reason: a `\\"` inside a value must not be read as ending the string.
        """
        start_index = raw_text.find(opening_character)

        if start_index == -1:
            return None

        depth = 0
        b_inside_string = False
        b_escaped = False

        for character_index in range(start_index, len(raw_text)):
            character = raw_text[character_index]

            if b_escaped:
                b_escaped = False
                continue

            if character == "\\":
                b_escaped = True
                continue

            if character == '"':
                b_inside_string = not b_inside_string
                continue

            if b_inside_string:
                continue

            if character == opening_character:
                depth += 1
            elif character == closing_character:
                depth -= 1

                if depth == 0:
                    return raw_text[start_index:character_index + 1]

        return None
