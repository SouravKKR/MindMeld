"""
ContentGuardrail

The entry point every other layer calls. Given a piece of model-generated text it
scans it, adjudicates whatever it found, removes the sentences that came back
abusive, and records what happened — in that order, with the expensive steps
reached only when the cheap one found something.

Where it is wired in:

  - AutomationCaller.call, which is the single choke point every non-streaming
    provider response passes through. Hooking there rather than in each provider
    also means the sanitised text is what ResponseCache stores, so cache entries
    are clean by construction.
  - GoogleEnterpriseAiProvider.stream_text, via StreamingContentGuardrail, which
    is the only path that does not go through AutomationCaller.

Invariants this file keeps, in priority order:

  1. It never raises. Every public method is wrapped, and any failure degrades to
     "leave the text exactly as it was". A guardrail that takes down a generation
     it was only meant to inspect is worse than the content it was inspecting.
  2. It never rewrites text that is not model output. Requests carrying no model
     are the local providers (DocumentProcessingProvider extracting text from a
     user's uploaded PDF), and rewriting a student's own document would be a
     data-integrity bug, not a safety feature.
  3. It fails open by default. See ContentGuardrailVerifier.is_fail_closed_enabled.
"""

import os

from Globals.Classes.Compliance.BannedTermMatch import BannedTermMatch
from Globals.Classes.Compliance.ContentGuardrailRedactor import ContentGuardrailRedactor
from Globals.Classes.Compliance.ContentGuardrailScanner import ContentGuardrailScanner
from Globals.Classes.Compliance.ContentGuardrailVerifier import ContentGuardrailVerifier
from Globals.Classes.Compliance.GuardedTextDocument import GuardedTextDocument
from Globals.Classes.Logging.LogTitles import LogTitles
from Globals.Classes.Logging.Logger import Logger
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Enumerations.ContentGuardrailOutcomes import ContentGuardrailOutcomes
from Globals.Enumerations.LogCategory import LogCategory


class ContentGuardrail:

    # How many flagged snippets are logged in full. The log entry is for a human
    # triaging a report, not an archive of the response, and logEvents documents
    # are read back into an admin table.
    MAXIMUM_LOGGED_SNIPPETS = 8

    # Ceiling on the characters of any one snippet kept in the log entry.
    MAXIMUM_LOGGED_SNIPPET_CHARACTERS = 400

    @staticmethod
    def is_enabled() -> bool:
        # The kill switch. Default ON; set CONTENT_GUARDRAIL_ENABLED=false to
        # take the whole feature out of the path without a deploy.
        return (os.getenv("CONTENT_GUARDRAIL_ENABLED") or "true").strip().lower() not in ("0", "false", "no")

    @staticmethod
    def is_enforcement_enabled() -> bool:
        # Default ON. Turning this off runs the full scan and adjudication and
        # logs the verdicts, but removes nothing — the shadow mode to run for a
        # first deploy when you want to see the real hit rate before letting it
        # edit anything. Mirrors SourceSimilarityScorer.is_enforcement_enabled.
        return (os.getenv("CONTENT_GUARDRAIL_ENFORCEMENT_ENABLED") or "true").strip().lower() not in ("0", "false", "no")

    @staticmethod
    async def sanitize_response(response, model: str | None, account_id: str = "") -> None:
        """
        Sanitises every TEXT output on an AutomationResponse in place, using the
        existing AutomationContent.set_data setter so downstream consumers, the
        response cache and the credit meter all see the cleaned text.

        `model` is the request's model. None means this was not an LLM call at
        all — the local providers build their requests that way — and the whole
        guardrail is skipped. See invariant 2 in the module docstring.
        """
        if response is None or model is None or not ContentGuardrail.is_enabled():
            return

        try:
            for content in response.get_outputs() or []:
                if content.get_content_type() != AutomationContentTypes.TEXT:
                    continue

                original_text = content.get_data()
                if not isinstance(original_text, str) or not original_text:
                    continue

                sanitized_text = await ContentGuardrail.sanitize_text(
                    original_text,
                    model = model,
                    account_id = account_id,
                )

                if sanitized_text != original_text:
                    content.set_data(sanitized_text)

        except Exception as guardrail_error:
            # Invariant 1. The response is already whatever it is; a failure here
            # must not propagate into the workflow that asked for it.
            print(f"[ContentGuardrail] Sanitisation failed, response left unchanged: {guardrail_error}")

    @staticmethod
    async def sanitize_text(text: str, model: str | None, account_id: str = "", source_label: str = "") -> str:
        """
        The whole pipeline for one piece of text. Returns the text with abusive
        sentences removed, or the input unchanged when nothing was found, the
        guardrail is disabled, enforcement is off, or anything failed.

        `model` has no default on purpose. It carries invariant 2 — None means
        "not model output, do not touch it" — and a default would let a caller
        that simply forgot the argument silently disable the guardrail instead of
        being an obvious error at the call site.
        """
        if not text or not isinstance(text, str) or model is None or not ContentGuardrail.is_enabled():
            return text

        try:
            document = GuardedTextDocument.from_text(text)
            segments = document.get_segments()

            # (segment_index, match) pairs, flattened so every match in the whole
            # response is adjudicated in ONE request rather than one per segment.
            flagged_entries = []
            for segment_index, segment_text in enumerate(segments):
                for match in ContentGuardrailScanner.scan(segment_text):
                    flagged_entries.append((segment_index, match))

            if not flagged_entries:
                return text

            return await ContentGuardrail.__adjudicate_and_redact(
                document,
                segments,
                flagged_entries,
                model = model,
                account_id = account_id,
                source_label = source_label,
            )

        except Exception as guardrail_error:
            print(f"[ContentGuardrail] Sanitisation failed, text left unchanged: {guardrail_error}")
            return text

    @staticmethod
    async def __adjudicate_and_redact(
        document: GuardedTextDocument,
        segments: list[str],
        flagged_entries: list,
        model: str | None,
        account_id: str,
        source_label: str,
    ) -> str:
        matches = [match for _, match in flagged_entries]

        b_has_overflow = len(matches) > ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST
        verdicts_by_match_index = await ContentGuardrailVerifier.verify(matches)

        b_verification_failed = verdicts_by_match_index is None
        if b_verification_failed:
            verdicts_by_match_index = {}

        abusive_entries = []
        verdict_reasons = []

        for match_index, (segment_index, match) in enumerate(flagged_entries):
            verdict = verdicts_by_match_index.get(match_index)

            if verdict is None:
                # Unadjudicated: either the call failed outright, or this item
                # fell past MAXIMUM_ITEMS_PER_REQUEST, or the reply came back
                # short. The configured failure mode decides, and it is recorded
                # rather than silently resolved either way.
                if not ContentGuardrailVerifier.is_fail_closed_enabled():
                    continue
                abusive_entries.append((segment_index, match))
                verdict_reasons.append(f"{match.get_term()}: unadjudicated, removed by fail-closed policy")
                continue

            if verdict.get("bAbusive"):
                abusive_entries.append((segment_index, match))
                verdict_reasons.append(f"{match.get_term()}: {verdict.get('reason') or 'abusive'}")

        outcome = ContentGuardrail.__resolve_outcome(
            b_verification_failed = b_verification_failed,
            b_has_overflow = b_has_overflow,
            b_has_abusive = bool(abusive_entries),
        )

        b_enforcement_enabled = ContentGuardrail.is_enforcement_enabled()

        if not abusive_entries or not b_enforcement_enabled:
            await ContentGuardrail.__log_outcome(
                # Shadow mode records what enforcement WOULD have done rather
                # than replacing it. Collapsing everything to SHADOW_LOGGED made
                # CLEARED and VERIFICATION_FAILED indistinguishable in exactly the
                # mode you run to measure the hit rate before switching on.
                outcome = ContentGuardrailOutcomes.SHADOW_LOGGED if not b_enforcement_enabled else outcome,
                would_be_outcome = outcome if not b_enforcement_enabled else None,
                matches = matches,
                abusive_entries = abusive_entries,
                verdict_reasons = verdict_reasons,
                removed_segment_count = 0,
                model = model,
                account_id = account_id,
                source_label = source_label,
            )
            return document.rebuild(segments)

        redacted_segments = list(segments)
        removed_segment_count = 0

        for segment_index in sorted({segment_index for segment_index, _ in abusive_entries}):
            segment_matches = [match for entry_segment_index, match in abusive_entries if entry_segment_index == segment_index]

            redacted_text, b_removed = ContentGuardrailRedactor.remove(segments[segment_index], segment_matches)

            if b_removed:
                redacted_segments[segment_index] = redacted_text
                removed_segment_count += 1

        await ContentGuardrail.__log_outcome(
            outcome = outcome,
            would_be_outcome = None,
            matches = matches,
            abusive_entries = abusive_entries,
            verdict_reasons = verdict_reasons,
            removed_segment_count = removed_segment_count,
            model = model,
            account_id = account_id,
            source_label = source_label,
        )

        return document.rebuild(redacted_segments)

    @staticmethod
    def __resolve_outcome(
        b_verification_failed: bool,
        b_has_overflow: bool,
        b_has_abusive: bool,
    ) -> ContentGuardrailOutcomes:
        # Nothing was judged abusive, so nothing was removed. That is CLEARED even
        # when the flagged count ran past the adjudication cap — reporting
        # OVERFLOW_REDACTED there would put a removal in the triage table that
        # never happened.
        if not b_has_abusive:
            return ContentGuardrailOutcomes.VERIFICATION_FAILED if b_verification_failed else ContentGuardrailOutcomes.CLEARED

        if b_verification_failed:
            return ContentGuardrailOutcomes.VERIFICATION_FAILED

        return ContentGuardrailOutcomes.OVERFLOW_REDACTED if b_has_overflow else ContentGuardrailOutcomes.REDACTED

    @staticmethod
    async def __log_outcome(
        outcome: ContentGuardrailOutcomes,
        would_be_outcome: ContentGuardrailOutcomes | None,
        matches: list[BannedTermMatch],
        abusive_entries: list,
        verdict_reasons: list[str],
        removed_segment_count: int,
        model: str | None,
        account_id: str,
        source_label: str,
    ) -> None:
        """
        One logEvents entry per flagged response. WARNING rather than INFO even
        for a CLEARED outcome: a flagged-then-cleared response is exactly the
        signal that tells you whether the allowlist needs another entry, and it
        is invisible at INFO in production.
        """
        try:
            flagged_terms = sorted({match.get_term() for match in matches})

            additional_data = {
                "outcome": int(outcome),
                "outcomeName": ContentGuardrailOutcomes(outcome).name,
                # Present only in shadow mode: what enforcement would have done.
                "wouldBeOutcomeName": ContentGuardrailOutcomes(would_be_outcome).name if would_be_outcome is not None else "",
                "model": model or "",
                # The queued paths have no user on hand at this depth, but every
                # one of them runs under a task, and a task resolves to a user.
                "taskId": os.environ.get("TASK_ID", ""),
                "sourceLabel": source_label,
                "flaggedTermCount": len(matches),
                "flaggedTerms": flagged_terms,
                "abusiveCount": len(abusive_entries),
                "removedSegmentCount": removed_segment_count,
                "verdictReasons": verdict_reasons[:ContentGuardrail.MAXIMUM_LOGGED_SNIPPETS],
                "snippets": [
                    match.get_context_snippet()[:ContentGuardrail.MAXIMUM_LOGGED_SNIPPET_CHARACTERS]
                    for match in matches[:ContentGuardrail.MAXIMUM_LOGGED_SNIPPETS]
                ],
            }

            message = (
                f"Content guardrail {ContentGuardrailOutcomes(outcome).name} - "
                f"{len(abusive_entries)} of {len(matches)} flagged term(s) removed"
            )

            await Logger.warning(
                LogCategory.AI_REQUEST,
                LogTitles.CONTENT_GUARDRAIL,
                message,
                account_id = account_id or "",
                additional_data = additional_data,
            )

        except Exception as logging_error:
            # Logging is the reason this feature exists, but it is still not
            # worth failing a generation over.
            print(f"[ContentGuardrail] Failed to record the guardrail outcome: {logging_error}")
