"""
GuardedTextDocument

Splits one piece of model output into the runs of prose that are worth scanning,
and puts them back together afterwards.

Why this exists. Most Gemini responses in this codebase are JSON — the provider
sets response_mime_type to application/json unless a caller opts out — so the raw
response text is not prose, it is prose wrapped in syntax. Scanning it as one flat
string causes two real problems:

  - A sentence span can run straight through `", "answer": "` and out the far
    side, so removing "the sentence" removes half the document. Every JSON
    response would then fall back to narrow term replacement, which is not what
    "remove the part of the sentence that had it" means.
  - The context window handed to the verification model fills up with braces and
    field names instead of the surrounding sentence.

So a JSON response is walked and its string VALUES become the segments. Each is
scanned, adjudicated and redacted on its own, and the document is rebuilt from
the parsed structure — which cannot produce malformed JSON, because it was never
edited as text.

Keys are deliberately not scanned. They are schema rather than content, and
rewriting one would break the field lookup the workflow does next.

Anything that is not JSON — HTML study material, plain markdown, an Ask AI
sentence — is a single segment and rebuilds to itself.
"""

import json


class GuardedTextDocument:

    def __init__(
        self,
        original_text: str,
        parsed_structure,
        segments: list[str],
        b_is_json: bool,
        fence_prefix: str = "",
        fence_suffix: str = "",
    ):
        self.__original_text = original_text
        self.__parsed_structure = parsed_structure
        self.__segments = segments
        self.__b_is_json = b_is_json
        self.__fence_prefix = fence_prefix
        self.__fence_suffix = fence_suffix

    @staticmethod
    def from_text(text: str) -> "GuardedTextDocument":
        # Gemini wraps JSON in a markdown fence often enough that the codebase
        # has a utility for unwrapping it (Globals/Utility/StripJsonMarkdown).
        # It has to be handled here too: a fenced payload that went unrecognised
        # would be treated as one flat string, and removing a "sentence" from
        # `{"answer": "..."}` on a single line takes the braces with it.
        fence_parts = GuardedTextDocument.__split_markdown_fence(text)
        body_text = fence_parts[1] if fence_parts is not None else text

        parsed_structure = GuardedTextDocument.__try_parse_json(body_text)

        if parsed_structure is None:
            # Plain text, including a fence around something that is not JSON.
            # Safe as one segment: the scanner treats a newline as a hard
            # sentence bound, so a removal can never reach the fence markers on
            # their own lines.
            return GuardedTextDocument(text, None, [text], b_is_json = False)

        segments = []
        GuardedTextDocument.__collect_strings(parsed_structure, segments)

        fence_prefix = fence_parts[0] if fence_parts is not None else ""
        fence_suffix = fence_parts[2] if fence_parts is not None else ""

        return GuardedTextDocument(
            text,
            parsed_structure,
            segments,
            b_is_json = True,
            fence_prefix = fence_prefix,
            fence_suffix = fence_suffix,
        )

    @staticmethod
    def __split_markdown_fence(text: str) -> tuple[str, str, str] | None:
        """
        Splits ```json\\n{...}\\n``` into (opening fence, body, closing fence), or
        returns None when the text is not fenced. A fence with no closing marker
        (a truncated reply) counts as not fenced, so the body is never guessed at.
        """
        if not text or not text.strip().startswith("```"):
            return None

        opening_fence_index = text.find("```")
        opening_newline_index = text.find("\n", opening_fence_index)

        if opening_newline_index == -1:
            return None

        closing_fence_index = text.rfind("```")

        if closing_fence_index <= opening_newline_index:
            return None

        # The newline separating the body from the closing marker belongs to the
        # fence, not the body. Keeping it here means the rebuilt text still has
        # its closing ``` at the start of a line, which is what a markdown
        # renderer requires and what the original looked like.
        # \r\n as well as \n, or a CRLF-terminated fence loses its carriage
        # return when the body is re-serialised.
        body_end_index = closing_fence_index
        if body_end_index > opening_newline_index and text[body_end_index - 1] == "\n":
            body_end_index -= 1
        if body_end_index > opening_newline_index and text[body_end_index - 1] == "\r":
            body_end_index -= 1

        return (
            text[:opening_newline_index + 1],
            text[opening_newline_index + 1:body_end_index],
            text[body_end_index:],
        )

    def get_segments(self) -> list[str]:
        """
        The runs of text to scan, in document order. For a JSON response these are
        its string values; for anything else it is a one-element list holding the
        whole text.
        """
        return self.__segments

    def is_json(self) -> bool:
        return self.__b_is_json

    def rebuild(self, redacted_segments: list[str]) -> str:
        """
        Reassembles the document from `redacted_segments`, which must be the same
        length and order as get_segments().

        Returns the ORIGINAL text unchanged when nothing was actually redacted, so
        an untouched response stays byte-for-byte identical rather than being
        re-serialised for no reason.
        """
        if len(redacted_segments) != len(self.__segments):
            print(
                f"[GuardedTextDocument] Segment count changed ({len(self.__segments)} -> "
                f"{len(redacted_segments)}) - keeping the original text."
            )
            return self.__original_text

        if redacted_segments == self.__segments:
            return self.__original_text

        if not self.__b_is_json:
            return redacted_segments[0]

        try:
            rebuilt_structure = GuardedTextDocument.__replace_strings(self.__parsed_structure, iter(redacted_segments))
            # ensure_ascii=False keeps the response readable and roughly its
            # original size; every consumer parses it with json.loads, so the
            # exact formatting does not matter, only that it parses.
            #
            # The fence is put back verbatim. A consumer that expected a fenced
            # reply and got a bare one would be a behaviour change introduced by
            # the guardrail, which is exactly what it must not do.
            return self.__fence_prefix + json.dumps(rebuilt_structure, ensure_ascii = False) + self.__fence_suffix
        except Exception as rebuild_error:
            print(f"[GuardedTextDocument] Failed to rebuild the JSON response: {rebuild_error} - keeping the original.")
            return self.__original_text

    @staticmethod
    def __try_parse_json(text: str):
        stripped_text = text.lstrip() if text else ""

        # Only objects and arrays are treated as structured. A bare JSON string or
        # number carries no field boundaries to protect, so it is better handled
        # as plain text.
        if not stripped_text or stripped_text[0] not in "{[":
            return None

        try:
            parsed_structure = json.loads(text)
        except Exception:
            return None

        return parsed_structure if isinstance(parsed_structure, (dict, list)) else None

    @staticmethod
    def __collect_strings(node, collected_segments: list[str]) -> None:
        # This MUST visit strings in exactly the order __replace_strings consumes
        # them, or redacted text lands in the wrong field. The two are written as
        # mirror images for that reason — change one, change the other. Recursion
        # depth is bounded by json.loads, which refuses to parse anything deeper
        # than the interpreter's recursion limit in the first place.
        if isinstance(node, dict):
            for value in node.values():
                GuardedTextDocument.__collect_strings(value, collected_segments)
        elif isinstance(node, list):
            for value in node:
                GuardedTextDocument.__collect_strings(value, collected_segments)
        elif isinstance(node, str):
            collected_segments.append(node)

    @staticmethod
    def __replace_strings(node, replacement_iterator):
        if isinstance(node, dict):
            return {key: GuardedTextDocument.__replace_strings(value, replacement_iterator) for key, value in node.items()}

        if isinstance(node, list):
            return [GuardedTextDocument.__replace_strings(value, replacement_iterator) for value in node]

        if isinstance(node, str):
            return next(replacement_iterator)

        return node
