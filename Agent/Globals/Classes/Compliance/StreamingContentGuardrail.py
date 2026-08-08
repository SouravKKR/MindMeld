"""
StreamingContentGuardrail

The guardrail for text being streamed to a browser token by token, which is the
one path AutomationCaller never sees: GoogleEnterpriseAiProvider.stream_text,
feeding Ask AI and Deck Chat.

The problem the buffered paths do not have is that emitted text cannot be
recalled. Once a fragment has gone out over the NDJSON stream it is on the user's
screen, so a term has to be caught BEFORE it is released, not after.

Two rules make that safe, and both are about where the buffer is allowed to be
cut:

  1. Release only whole sentences. A sentence is scanned in full before any of it
     leaves, so a removal can take the entire sentence exactly as the
     non-streaming path does, instead of leaving a dangling lead-in.

  2. Never release the last `SAFE_RELEASE_MARGIN_CHARACTERS` characters. A term
     that straddles the cut is then guaranteed to lie wholly inside the buffer
     that was just scanned, so it cannot be split into two halves that each look
     innocent. This is not theoretical: `\\n` ends a sentence, and a multi-word
     entry is allowed to match across a line wrap, so "hand\\njob" would otherwise
     be cut into "hand" and "job" and sail straight through.

The scan is run over the WHOLE pending buffer rather than just the sentence about
to be released, for the same reason.

When the buffer trips the scan, releasing stops and buffering continues until 25
words exist after the LAST match, because the adjudicator is shown 25 words either
side and the trailing ones have not been generated yet. A run with no sentence
terminator at all (a fenced code block, a table, a long bullet list) is
force-flushed at MAXIMUM_PENDING_CHARACTERS so it can never buffer the whole
reply.

Cost: text arrives sentence by sentence instead of word by word, so the first
sentence of a reply is delayed by roughly its own generation time. After that the
stream runs at the normal rate, because sentence N+1 generates while sentence N
is being released.
"""

import re

from Globals.Classes.Compliance.BannedTermLexicon import BannedTermLexicon
from Globals.Classes.Compliance.ContentGuardrail import ContentGuardrail
from Globals.Classes.Compliance.ContentGuardrailScanner import ContentGuardrailScanner


class StreamingContentGuardrail:

    # A sentence terminator followed by whitespace, or a newline. Mirrors the rule
    # ContentGuardrailScanner uses, so the streamed split and the removal agree
    # about where a sentence ends.
    __SENTENCE_BOUNDARY_PATTERN = re.compile(r"[.!?](?=\s)|\n")

    __WORD_PATTERN = re.compile(r"\S+")
    __WHITESPACE_PATTERN = re.compile(r"\s")

    # Slack added on top of the longest active term when deciding how much of the
    # tail to withhold. A multi-word entry matches its separators as runs
    # (`[\s\-]+`), so the text form of a term can be longer than the entry itself;
    # this covers that without needing to reason about how much whitespace a model
    # might emit.
    TERM_LENGTH_SAFETY_MARGIN_CHARACTERS = 64

    # Force-flush ceiling for text containing no sentence boundary. Roughly a long
    # paragraph: large enough that ordinary prose never reaches it, small enough
    # that a code block does not stall the stream.
    MAXIMUM_PENDING_CHARACTERS = 2000

    # How many words must arrive after the last match before it is adjudicated.
    # Matches ContentGuardrailScanner.WORDS_OF_CONTEXT_EACH_SIDE.
    WORDS_OF_TRAILING_CONTEXT_REQUIRED = 25

    def __init__(self, model: str | None = None, account_id: str = ""):
        self.__model = model
        self.__account_id = account_id

        # Text received from the provider but not yet released to the caller.
        self.__pending_text = ""

    async def accept(self, chunk_text: str) -> list[str]:
        """
        Takes one chunk from the provider and returns the fragments that are safe
        to emit now, in order. Returns an empty list while text is still being
        buffered. Never raises: on failure it releases the pending text unchanged,
        because stalling a user's reply is worse than missing a scan.
        """
        if not chunk_text:
            return []

        try:
            self.__pending_text += chunk_text
            return await self.__release_what_is_safe(b_final = False)
        except Exception as streaming_error:
            print(f"[StreamingContentGuardrail] Failed mid-stream, releasing buffered text: {streaming_error}")
            return self.__release_everything_unchecked()

    async def flush(self) -> list[str]:
        """
        Called once when the provider's stream ends. Adjudicates and releases
        whatever is left, including a trailing partial sentence that never got its
        terminator.
        """
        if not self.__pending_text:
            return []

        try:
            return await self.__release_what_is_safe(b_final = True)
        except Exception as streaming_error:
            print(f"[StreamingContentGuardrail] Failed on flush, releasing buffered text: {streaming_error}")
            return self.__release_everything_unchecked()

    async def __release_what_is_safe(self, b_final: bool) -> list[str]:
        if not self.__pending_text:
            return []

        # Scanning the whole buffer, not just the part about to be released, is
        # what makes rule 2 hold: a term overlapping the cut is seen here.
        if ContentGuardrailScanner.contains_banned_term(self.__pending_text):
            if not b_final and not self.__has_enough_trailing_context():
                return []
            return await self.__sanitize_and_release(b_final)

        # The stream has ended and the buffer is clean, so everything goes —
        # including a trailing partial sentence, whose final "." has no following
        # whitespace to confirm it and would otherwise be left behind forever.
        if b_final:
            return self.__release_everything_unchecked()

        release_limit = self.__resolve_release_limit(b_final)
        if release_limit <= 0:
            return []

        boundary_index = self.__find_last_sentence_boundary(self.__pending_text, release_limit)

        if boundary_index is None:
            if len(self.__pending_text) < StreamingContentGuardrail.MAXIMUM_PENDING_CHARACTERS:
                return []

            # No sentence in sight and the buffer is large. Cut on whitespace
            # rather than mid-word so the released text still reads correctly.
            boundary_index = self.__find_last_whitespace_boundary(self.__pending_text, release_limit)

        if boundary_index is None or boundary_index <= 0:
            return []

        released_text = self.__pending_text[:boundary_index]
        self.__pending_text = self.__pending_text[boundary_index:]

        return [released_text] if released_text else []

    async def __sanitize_and_release(self, b_final: bool) -> list[str]:
        # Sanitise BEFORE clearing the buffer. If the await is cancelled the
        # pending text is still intact, so the caller's fallback has something to
        # release rather than silently losing the reply.
        sanitized_text = await ContentGuardrail.sanitize_text(
            self.__pending_text,
            model = self.__model,
            account_id = self.__account_id,
            source_label = "askAiStream",
        )

        if b_final:
            self.__pending_text = ""
            return [sanitized_text] if sanitized_text else []

        # Keep the usual margin so rule 2 still holds across THIS release too. The
        # retained tail has already been scanned; re-examining it next round only
        # matters if the following chunk extends it into a term, which is exactly
        # the case worth catching.
        retained_length = min(len(sanitized_text), self.__resolve_safe_release_margin())
        split_index = len(sanitized_text) - retained_length

        released_text = sanitized_text[:split_index]
        self.__pending_text = sanitized_text[split_index:]

        return [released_text] if released_text else []

    def __release_everything_unchecked(self) -> list[str]:
        released_text = self.__pending_text
        self.__pending_text = ""

        return [released_text] if released_text else []

    def __resolve_safe_release_margin(self) -> int:
        return (
            BannedTermLexicon.get_maximum_term_length()
            + StreamingContentGuardrail.TERM_LENGTH_SAFETY_MARGIN_CHARACTERS
        )

    def __resolve_release_limit(self, b_final: bool) -> int:
        """
        How far into the buffer a release may reach. At the end of the stream that
        is everything; otherwise it stops short by the safe margin so no term can
        straddle the cut.
        """
        if b_final:
            return len(self.__pending_text)

        return max(0, len(self.__pending_text) - self.__resolve_safe_release_margin())

    def __has_enough_trailing_context(self) -> bool:
        """
        True once at least 25 words exist after the LAST match in the buffer, so
        the adjudicator sees what follows the term rather than a sentence that
        stops dead at it.

        Measured from the last match rather than the last sentence boundary: the
        boundary moves forward with every completed sentence, so counting from it
        would reset the tally each time and the buffer would never release.
        """
        matches = ContentGuardrailScanner.scan(self.__pending_text)

        if not matches:
            return True

        trailing_text = self.__pending_text[matches[-1].get_end_index():]
        trailing_word_count = len(StreamingContentGuardrail.__WORD_PATTERN.findall(trailing_text))

        if trailing_word_count >= StreamingContentGuardrail.WORDS_OF_TRAILING_CONTEXT_REQUIRED:
            return True

        return len(self.__pending_text) >= StreamingContentGuardrail.MAXIMUM_PENDING_CHARACTERS

    @staticmethod
    def __find_last_sentence_boundary(text: str, release_limit: int) -> int | None:
        """
        The index just past the last completed sentence at or before
        `release_limit`, or None when there is none.

        The last rather than the first, so a chunk carrying several sentences is
        released as one fragment instead of one round trip each.
        """
        last_boundary_index = None

        for boundary_match in StreamingContentGuardrail.__SENTENCE_BOUNDARY_PATTERN.finditer(text):
            if boundary_match.end() > release_limit:
                break
            last_boundary_index = boundary_match.end()

        return last_boundary_index

    @staticmethod
    def __find_last_whitespace_boundary(text: str, release_limit: int) -> int | None:
        last_boundary_index = None

        for whitespace_match in StreamingContentGuardrail.__WHITESPACE_PATTERN.finditer(text):
            if whitespace_match.end() > release_limit:
                break
            last_boundary_index = whitespace_match.end()

        return last_boundary_index
