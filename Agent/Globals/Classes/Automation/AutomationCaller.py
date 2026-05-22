from typing import Callable

from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.ResponseCache import ResponseCache
from Globals.Classes.Automation.ShadowModelEvaluator import ShadowModelEvaluator


class AutomationCaller:

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
        Runs a pre-populated BatchSubmitter, falling back to live API on validator failure
        or batch failure so coverage is preserved.

        Returns: dict[key, AutomationResponse | None] aligned with submitter.get_entries().
        """
        entries    = submitter.get_entries()
        validators = validators or {}
        results    = {}

        cache_hits = []
        for entry in entries:
            cache_key       = ResponseCache.compute_key(entry["request"])
            entry["cache_key"] = cache_key
            cached_response = await ResponseCache.lookup(cache_key) if cache_key is not None else None

            if cached_response is None:
                continue

            validator = validators.get(entry["key"])
            if validator is None or validator(cached_response):
                results[entry["key"]] = cached_response
                cache_hits.append(entry["key"])

        if cache_hits:
            print(f"[AutomationCaller] call_batch: {len(cache_hits)}/{len(entries)} served from cache")

        pending_entries = [entry for entry in entries if entry["key"] not in results]

        if not pending_entries:
            return results

        await submitter.submit()
        succeeded = await submitter.wait_for_completion()

        batch_responses = {}
        if succeeded:
            batch_responses = await submitter.collect_results()

        fallback_caller = live_fallback_caller if live_fallback_caller is not None else self

        for entry in pending_entries:
            key       = entry["key"]
            validator = validators.get(key)
            response  = batch_responses.get(key) if succeeded else None

            if response is not None and (validator is None or validator(response)):
                results[key] = response
                if entry.get("cache_key") is not None:
                    await ResponseCache.store(entry["cache_key"], response)
                ShadowModelEvaluator.maybe_sample_and_shadow(entry["request"], response, key)
                continue

            print(f"[AutomationCaller] call_batch: falling back to live API for key '{key}'")
            live_response = await fallback_caller.call(entry["request"], validator)
            results[key]  = live_response

        return results
