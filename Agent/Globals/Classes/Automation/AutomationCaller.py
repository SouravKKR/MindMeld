import asyncio

from typing import Callable

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.ResponseCache import ResponseCache
from Globals.Classes.Automation.ShadowModelEvaluator import ShadowModelEvaluator
from Globals.Classes.Compliance.ContentGuardrail import ContentGuardrail
from Globals.Classes.Credits.CreditMeter import CreditMeter


class AutomationCaller:

    # Upper bound on how many entries of a collected group run live at once.
    # The provider's RedisSemaphore still enforces the real per-model API
    # concurrency ceiling across the cluster; this only bounds the number of
    # in-flight coroutines a single call_batch fan-out creates.
    MAX_LIVE_BATCH_CONCURRENCY = 8

    def __init__(self, provider: AutomationProvider, b_enable_content_guardrail: bool = True):
        self.__provider = provider

        # Off for exactly one caller: ContentGuardrailVerifier, which asks a model
        # to adjudicate flagged text and would otherwise have its own reply
        # scanned — a reply that contains the flagged terms by construction, so
        # the guardrail would flag it, verify it, and recurse forever.
        self.__b_enable_content_guardrail = b_enable_content_guardrail

    @staticmethod
    def __joined_text_output(response: AutomationResponse) -> str | None:
        """
        The response's text outputs joined together, used only as a chars/4
        token-estimate fallback for cache entries written before usage was
        persisted. Non-text outputs contribute nothing to a token estimate and
        are skipped. Returns None when there is no text to estimate from.
        """
        text_fragments = []

        for content in response.get_outputs() or []:
            data = content.get_data()
            if isinstance(data, str) and data:
                text_fragments.append(data)

        return "\n".join(text_fragments) if text_fragments else None

    async def call(self, request: AutomationRequest, validator: Callable[[AutomationResponse], bool] | None, retries: int = 3) -> AutomationResponse:
        cache_key       = ResponseCache.compute_key(request)
        cached_response = await ResponseCache.lookup(cache_key) if cache_key is not None else None

        if cached_response is not None:
            if validator is None or validator(cached_response):
                # Entries written since the guardrail shipped are already clean —
                # the sanitisation below happens before ResponseCache.store — so
                # this normally costs one regex pass and finds nothing. It is here
                # for the entries written BEFORE it shipped, which live for up to
                # ResponseCache.TTL_DAYS and would otherwise serve unscanned text.
                await self.__apply_content_guardrail(cached_response, request)
                # A hit returns without ever reaching the provider, so nothing
                # else in this path will meter it. Record the original call's
                # usage here or the task bills zero for work it delivered — and
                # because the cache key is model + prompt with no account in it,
                # that zero would apply to every user who ever asks for the same
                # thing, not just the one who warmed the entry.
                CreditMeter.record_cached_usage(
                    cached_response.get_usage_metadata(),
                    model = request.get_model(),
                    fallback_input_text = request.get_text_content(),
                    fallback_output_text = AutomationCaller.__joined_text_output(cached_response),
                )
                return cached_response

        response = await self.__provider.execute(request)

        # Before the validator, before the cache write, before shadow sampling —
        # so every one of them sees the sanitised text and a stored entry can
        # never replay content the guardrail already removed.
        await self.__apply_content_guardrail(response, request)

        if validator is not None:
            b_valid_response = validator(response)

            if b_valid_response:
                if cache_key is not None:
                    await ResponseCache.store(cache_key, response)
                ShadowModelEvaluator.maybe_sample_and_shadow(request, response)
                return response

            retries -= 1
            if retries > 0:
                return await self.call(request, validator, retries)

            return None

        if cache_key is not None:
            await ResponseCache.store(cache_key, response)
        ShadowModelEvaluator.maybe_sample_and_shadow(request, response)

        return response

    async def __apply_content_guardrail(self, response: AutomationResponse, request: AutomationRequest) -> None:
        """
        Runs the content guardrail over a response's text outputs, in place.

        A request carrying no model is not an LLM call at all — that is how
        ProcessSyllabus builds requests for the local DocumentProcessingProvider,
        whose "output" is text extracted from a student's uploaded PDF. Rewriting
        that would be a data-integrity bug rather than a safety feature, so the
        model name is passed through and ContentGuardrail skips a None.
        """
        if not self.__b_enable_content_guardrail or response is None:
            return

        await ContentGuardrail.sanitize_response(response, model = request.get_model())

    async def call_batch(
        self,
        submitter,
        live_fallback_caller: "AutomationCaller" = None,
        validators: dict = None,
    ) -> dict:
        """
        Executes every entry collected in `submitter` live and bounded-
        concurrently.

        The batch API was removed (see BatchSubmitter, now a thin request
        collector): the Agent's enterprise API key cannot reach the backend's
        GCS/BigQuery batch jobs. Each collected (key, request) pair is run
        through the live provider via `call()`, which already handles response
        caching, validator-driven retries and shadow sampling — so cache hits,
        stores and validation are preserved without a separate pre-pass here.
        Per-model API concurrency is still capped inside the provider's
        RedisSemaphore; the local semaphore only bounds the in-flight fan-out.

        Returns: dict[key, AutomationResponse | None] aligned with submitter.get_entries().
        """
        entries    = submitter.get_entries()
        validators = validators or {}

        if not entries:
            return {}

        fallback_caller   = live_fallback_caller if live_fallback_caller is not None else self
        concurrency_limit = max(1, min(len(entries), AutomationCaller.MAX_LIVE_BATCH_CONCURRENCY))
        concurrency_gate  = asyncio.Semaphore(concurrency_limit)

        async def run_entry(entry):
            key       = entry["key"]
            validator = validators.get(key)
            async with concurrency_gate:
                response = await fallback_caller.call(entry["request"], validator)
            return key, response

        completed = await asyncio.gather(*[run_entry(entry) for entry in entries])

        return { key: response for key, response in completed }

    async def aclose(self):
        """
        Releases the underlying provider's HTTP resources, when it exposes an
        aclose. A short-lived caller (e.g. the one EnhanceImages builds) can then
        shut its provider's async client down cleanly instead of leaking sockets
        or stalling interpreter teardown. A provider without aclose is a no-op.
        """
        if hasattr(self.__provider, "aclose"):
            await self.__provider.aclose()
