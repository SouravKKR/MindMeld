"""
ContentGuardrailVerifier

Second stage of the guardrail. The scan says "this word is on the list"; this
says "and it is actually being used abusively". Everything expensive lives here,
so it only ever runs on a response that already tripped the deterministic pass.

Batching. Every match found in one response goes into ONE request. A study
material that mentions the same term eight times costs one short flash-lite call,
not eight. Verdicts come back keyed by item index and are mapped straight back
onto the matches.

Recursion. This makes an LLM call from inside the hook that inspects LLM calls,
so its caller is constructed with the guardrail explicitly disabled. Without that
the verification response would itself be scanned, flagged (the prompt and the
snippets are full of banned terms by construction) and sent for verification,
forever.

Caching is deliberately left ON. The request is routed through AutomationCaller
like any other call, so ResponseCache keys it on model plus prompt text — the same
snippet asked about twice returns the stored verdict without a network round trip.
"""

import asyncio
import os

from Globals.Classes.Compliance.BannedTermMatch import BannedTermMatch
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Utility.StripJsonMarkdown import strip_json_markdown

# The Automation imports are deliberately NOT at module scope. AutomationCaller
# imports ContentGuardrail (that is where the hook lives), ContentGuardrail
# imports this file, and this file needs AutomationCaller — a cycle. ModelPool
# closes a second one through GoogleEnterpriseAiProvider, which reaches
# StreamingContentGuardrail. Importing them inside the one method that calls a
# model breaks both, and matches how TaskRunner and the PDF/torch call sites
# already defer their heavy imports.


class ContentGuardrailVerifier:

    # Hard ceiling on how many snippets go into one adjudication request. Twenty
    # five snippets of about fifty-five words is roughly two thousand tokens,
    # which flash-lite handles comfortably in one pass. A response with more
    # flagged terms than this is already so saturated that the extra items add no
    # information — they are handled by the caller as an overflow, not silently
    # dropped.
    MAXIMUM_ITEMS_PER_REQUEST = 25

    # The Redis semaphore pool this call queues in, deliberately NOT the model
    # name. GoogleEnterpriseAiProvider.stream_text holds a slot in the model's
    # bucket for the whole lifetime of a stream, and the guardrail runs inside
    # that stream. Sharing the bucket would mean a guarded flash-lite stream
    # waiting for a flash-lite slot that only it could release — with enough
    # concurrent streams, every one of them blocked on the others, and
    # RedisSemaphore's acquire loop polls forever rather than timing out.
    # A separate pool makes the guardrail structurally unable to starve the
    # traffic it inspects. Its size lives in Common/Constants/ApiConcurrencyLimits.json.
    CONCURRENCY_BUCKET = "content-guardrail"

    # Retries inside AutomationCaller are validator-driven. Two attempts is
    # enough for a transient malformed-JSON reply; beyond that the guardrail
    # falls back to its configured failure mode rather than stalling a generation
    # that has already produced its real output.
    VERIFICATION_RETRY_COUNT = 2

    # Wall-clock ceiling on the whole adjudication. The guardrail sits between a
    # finished model response and the code waiting to persist it, and on the
    # Ask AI path it sits between generated tokens and the browser. A verifier
    # that hangs must not hold either of them open indefinitely.
    VERIFICATION_TIMEOUT_SECONDS = 30

    @staticmethod
    def is_fail_closed_enabled() -> bool:
        # What to do when the adjudication cannot be completed. Default is fail
        # OPEN: keep the text, log the failure. A wrongly removed sentence
        # silently corrupts study material a student has paid for, while a
        # wrongly kept one is recorded in logEvents and can be reviewed.
        return (os.getenv("CONTENT_GUARDRAIL_FAIL_CLOSED") or "").strip().lower() in ("1", "true", "yes")

    @staticmethod
    async def verify(matches: list[BannedTermMatch]) -> dict[int, dict] | None:
        """
        Adjudicates up to MAXIMUM_ITEMS_PER_REQUEST matches in a single call.

        Returns a dict keyed by the INDEX INTO `matches`, each value
        {"bAbusive": bool, "reason": str}. Returns None when the adjudication
        could not be completed at all — the caller decides what that means by
        consulting is_fail_closed_enabled(). Never raises.
        """
        if not matches:
            return {}

        considered_matches = matches[:ContentGuardrailVerifier.MAXIMUM_ITEMS_PER_REQUEST]

        try:
            raw_response = await asyncio.wait_for(
                ContentGuardrailVerifier.__request_verdicts(considered_matches),
                timeout = ContentGuardrailVerifier.VERIFICATION_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            print(
                f"[ContentGuardrailVerifier] Adjudication timed out after "
                f"{ContentGuardrailVerifier.VERIFICATION_TIMEOUT_SECONDS}s for {len(considered_matches)} item(s)."
            )
            return None
        except Exception as verification_error:
            print(f"[ContentGuardrailVerifier] Adjudication failed: {verification_error}")
            return None

        if raw_response is None:
            return None

        return ContentGuardrailVerifier.__parse_verdicts(raw_response, len(considered_matches))

    @staticmethod
    async def __request_verdicts(matches: list[BannedTermMatch]) -> str | None:
        # Deferred to break the import cycles described at the top of this file.
        from Globals.Classes.Automation.AutomationCaller import AutomationCaller
        from Globals.Classes.Automation.AutomationContent import AutomationContent
        from Globals.Classes.Automation.AutomationRequest import AutomationRequest
        from Globals.Classes.Automation.Pools.ModelPool import ModelPool
        from Globals.Classes.Automation.Pools.PromptPool import PromptPool

        model_name, provider_class = ModelPool.CONTENT_GUARDRAIL_MODEL

        numbered_items = ContentGuardrailVerifier.__build_numbered_items(matches)
        user_prompt = PromptPool.CONTENT_GUARDRAIL_VERIFICATION_USER.format(
            item_count = len(matches),
            numbered_items = numbered_items,
        )

        request = AutomationRequest(
            model_name,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.CONTENT_GUARDRAIL_VERIFICATION_SYSTEM),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    user_prompt,
                    {"concurrency_bucket": ContentGuardrailVerifier.CONCURRENCY_BUCKET},
                ),
            ],
        )

        # b_enable_content_guardrail = False is the recursion guard. See the
        # module docstring: without it this call's own response is scanned, and
        # it is guaranteed to contain the very terms being adjudicated.
        #
        # A provider is built and closed per adjudication rather than memoised on
        # this class. It costs a client construction, but the alternative binds an
        # httpx.AsyncClient to whichever event loop happened to be running first,
        # and the Agent's entry points each own their own asyncio.run. This
        # matches how EnhanceImages builds its short-lived caller, and it only
        # happens on a response that actually tripped the scan.
        caller = AutomationCaller(provider_class(), b_enable_content_guardrail = False)

        try:
            response = await caller.call(
                request,
                ContentGuardrailVerifier.__validate_response,
                retries = ContentGuardrailVerifier.VERIFICATION_RETRY_COUNT,
            )
        finally:
            await caller.aclose()

        if response is None:
            return None

        # get_output() indexes straight into the list, so an empty-output response
        # would raise rather than return None. The validator above rejects that
        # shape, but this path must hold on its own.
        outputs = response.get_outputs() or []
        if not outputs:
            return None

        data = outputs[0].get_data()

        return data if isinstance(data, str) else None

    @staticmethod
    def __build_numbered_items(matches: list[BannedTermMatch]) -> str:
        item_lines = []

        for item_index, match in enumerate(matches, start = 1):
            item_lines.append(
                f"[{item_index}] flagged word: {match.get_matched_text()}\n"
                f"    context: {match.get_context_snippet()}"
            )

        return "\n\n".join(item_lines)

    @staticmethod
    def __validate_response(response) -> bool:
        # Cheap shape check so AutomationCaller retries a truncated or prose-
        # wrapped reply rather than handing back something unparseable.
        if response is None:
            return False

        outputs = response.get_outputs() or []
        if not outputs:
            return False

        data = outputs[0].get_data()
        if not isinstance(data, str) or not data.strip():
            return False

        parsed = strip_json_markdown(data)

        return isinstance(parsed, dict) and isinstance(parsed.get("verdicts"), list)

    @staticmethod
    def __parse_verdicts(raw_response: str, expected_item_count: int) -> dict[int, dict] | None:
        parsed = strip_json_markdown(raw_response)

        if not isinstance(parsed, dict):
            print("[ContentGuardrailVerifier] Adjudication reply was not a JSON object.")
            return None

        raw_verdicts = parsed.get("verdicts")
        if not isinstance(raw_verdicts, list):
            print("[ContentGuardrailVerifier] Adjudication reply carried no verdicts array.")
            return None

        verdicts_by_match_index = {}

        for raw_verdict in raw_verdicts:
            if not isinstance(raw_verdict, dict):
                continue

            item_index = raw_verdict.get("index")
            if not isinstance(item_index, int):
                continue

            # Items are one-based in the prompt; matches are zero-based here.
            match_index = item_index - 1
            if match_index < 0 or match_index >= expected_item_count:
                continue

            verdicts_by_match_index[match_index] = {
                "bAbusive": bool(raw_verdict.get("bAbusive")),
                "reason": str(raw_verdict.get("reason") or "")[:200],
            }

        if not verdicts_by_match_index:
            print("[ContentGuardrailVerifier] Adjudication reply contained no usable verdicts.")
            return None

        # A partial reply is honoured for what it did answer. Anything missing is
        # left absent rather than defaulted, so the caller applies its configured
        # failure mode per item instead of assuming a silent "acceptable".
        if len(verdicts_by_match_index) != expected_item_count:
            print(
                f"[ContentGuardrailVerifier] Adjudication returned {len(verdicts_by_match_index)} verdict(s) "
                f"for {expected_item_count} item(s)."
            )

        return verdicts_by_match_index
