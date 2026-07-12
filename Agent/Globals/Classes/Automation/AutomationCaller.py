import asyncio

from typing import Callable

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.ResponseCache import ResponseCache
from Globals.Classes.Automation.ShadowModelEvaluator import ShadowModelEvaluator


class AutomationCaller:

    # Upper bound on how many entries of a collected group run live at once.
    # The provider's RedisSemaphore still enforces the real per-model API
    # concurrency ceiling across the cluster; this only bounds the number of
    # in-flight coroutines a single call_batch fan-out creates.
    MAX_LIVE_BATCH_CONCURRENCY = 8

    def __init__(self, provider: AutomationProvider):
        self.__provider = provider

    async def call(self, request: AutomationRequest, validator: Callable[[AutomationResponse], bool] | None, retries: int = 3) -> AutomationResponse:
        cache_key       = ResponseCache.compute_key(request)
        cached_response = await ResponseCache.lookup(cache_key) if cache_key is not None else None

        if cached_response is not None:
            if validator is None or validator(cached_response):
                return cached_response

        response = await self.__provider.execute(request)

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
