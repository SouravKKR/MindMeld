import os
import sys
import asyncio
import base64

from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.ProviderHealthSignal import ProviderHealthSignal
from Globals.Classes.Generic.RedisSemaphore import RedisSemaphore
from Globals.Classes.WebScraping.WebContentFetcher import WebContentFetcher
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Constants.ApiConcurrencyLimits import ApiConcurrencyLimits
from Globals.Constants.ReasoningEffortLevels import ReasoningEffortLevels

import anthropic


class AnthropicProvider(AutomationProvider):
    """
    Anthropic (Claude) provider.

    Routed to exactly like every other provider: a ModelPool entry reads
    (model_string, AnthropicProvider), and the workflow calls
    AutomationCaller(provider_class()).call(request, validator). The
    AutomationRequest / AutomationResponse contract, the AutomationContentTypes
    handling, the RedisSemaphore concurrency gate, the transient-error retry
    policy and the CreditMeter accounting all mirror GoogleEnterpriseAiProvider
    so a caller can swap providers without knowing which one it got.

    Three things differ from the Google provider and are the only semantic
    differences worth calling out:

      1. Authentication is a single API key (ANTHROPIC_API_KEY). There is no
         service-account path and therefore no silent fallback: an unset key
         raises at construction rather than degrading to another provider. A
         paid-deck run that quietly ran on a different model would invalidate
         the audit trail that says which model produced the content.

      2. Reasoning effort is a first-class request parameter
         (output_config.effort), not a thinking-token budget. Callers pass it
         through AutomationContent metadata as "reasoning_effort"; Phase 4's
         symbolic-diagram generation sets it to HIGH because a mislabelled
         diagram is worse than no diagram. Everything else leaves it unset and
         takes the API default.

      3. Every call streams. The SDK's non-streaming path risks an HTTP timeout
         above roughly 16K output tokens, and diagram / verification responses
         are long, so a single streaming code path is used throughout and the
         complete message is collected with get_final_message().

    DATA GOVERNANCE
    ---------------
    Recorded here, at the point the code depends on it, for the same reason
    OpenAiProvider records `store=False` and GoogleEnterpriseAiProvider refuses
    to fall back to Vertex Express: a posture inherited silently from a platform
    default is one nobody can audit, and the first person to ask "what happens
    to what we send here" should find the answer in the code rather than in a
    vendor page that may since have changed.

    What the platform does by default:

      - Anthropic does NOT train its models on data submitted through the API.
        This is the commercial-API default and needs no per-request parameter,
        which is why there is no `store`-equivalent flag set below — unlike the
        OpenAI path, there is nothing to opt out of.
      - Inputs and outputs are retained for up to 30 days for trust-and-safety
        and abuse monitoring, then deleted. This is a platform-level retention
        window, not something a request parameter can shorten.
      - Zero data retention (ZDR) removes that 30-day window, but it is an
        ACCOUNT-LEVEL agreement arranged with Anthropic. It cannot be enabled
        from client code, so this provider cannot assert it and does not claim
        it. If ZDR is obtained for the account behind ANTHROPIC_API_KEY, record
        it here so the three providers can be compared from source alone.

    What this provider is allowed to receive:

      Curriculum metadata (syllabus topic names, coverage specifications), the
      pipeline's own generated content, and rendered images of its own generated
      diagrams. It must NOT receive user-uploaded document text. That boundary
      is a property of the callers — see the route-boundary note on the
      ModelPool.PAID_DECK_* entries — and holds today because paid-deck mode
      accepts no uploaded documents at all (PaidDeckGenerationGate). It is
      stated here as well because a future caller reading this class is the
      person most likely to breach it, and because the 30-day retention window
      above is materially different in consequence for a user's private textbook
      than for a syllabus topic list.
    """

    # Characters of fetched page text attached per grounding link. Matches the
    # Google provider so a workflow that supplies "search_results" behaves
    # identically whichever provider serves it.
    GROUNDING_CONTENT_CHAR_BUDGET = 8000

    # Output ceiling when the caller does not specify one. Claude Opus 5 accepts
    # up to 128K, but an unbounded default would let a runaway generation bill a
    # very large response.
    #
    # This budget is shared: on Claude Opus 5 thinking is ON unless the request
    # explicitly disables it, and max_tokens caps thinking PLUS the visible
    # response together. The model is not told the limit, so it does not pace
    # itself — it simply stops mid-token when the budget runs out. At 16K a
    # multi-topic structured response could spend most of the budget thinking
    # and emit JSON that ended halfway through an object, which every caller
    # then saw as "the model returned a malformed shape" rather than "the
    # response was cut off". 32K leaves room for both parts.
    DEFAULT_MAX_OUTPUT_TOKENS = 32000

    # Retry policy, deliberately identical in shape to GoogleEnterpriseAiProvider:
    # 429 (rate / quota) and 5xx (server-side capacity) are transient and retried
    # with backoff; the API's Retry-After header is honoured when present. "Slow
    # is fine, failure is not" — a capacity blip must not fail a paid-deck run
    # halfway through.
    MAX_TRANSIENT_RETRIES = 8
    DEFAULT_RETRY_SLEEP_SECONDS = 8.0
    MAX_RETRY_SLEEP_SECONDS = 60.0

    # Anthropic's server-side web-search tool. Used only where a workflow asks
    # for grounding (Phase 2 coverage reconciliation, Phase 6 currency checks) —
    # never to source chunk content.
    WEB_SEARCH_TOOL_TYPE = "web_search_20260209"
    WEB_SEARCH_TOOL_NAME = "web_search"

    # Emitted once per process so the resolved model and auth mode are visible in
    # every worker's log without repeating on each provider construction.
    __b_auth_mode_logged = False

    def __init__(self):
        api_key = (os.getenv("ANTHROPIC_API_KEY") or "").strip()

        if not api_key:
            raise RuntimeError(
                "AnthropicProvider requires ANTHROPIC_API_KEY to be set. Refusing to "
                "start without it — silently falling back to another provider would "
                "mean the generated content was produced by a model the provenance "
                "record does not name."
            )

        self.__client = anthropic.AsyncAnthropic(api_key=api_key)
        AnthropicProvider.__log_resolved_auth_mode()

    @staticmethod
    def __log_resolved_auth_mode() -> None:
        if AnthropicProvider.__b_auth_mode_logged:
            return
        AnthropicProvider.__b_auth_mode_logged = True
        print(
            "[AnthropicProvider] Resolved auth mode: API_KEY (ANTHROPIC_API_KEY)",
            file=sys.stderr, flush=True,
        )

    async def aclose(self):
        """
        Releases the underlying HTTP client so a short-lived owner can shut down
        without leaking sockets or stalling asyncio.run() teardown. Idempotent
        and error-swallowing — a close fault must never fail a task.
        """
        try:
            await self.__client.close()
        except Exception as close_error:
            print(f"[AnthropicProvider] client close failed (continuing): {close_error}")

    async def __fetch_url_content(self, url: str) -> str:
        try:
            text = await WebContentFetcher.fetch_text_only(url)
            if not text:
                return f"Source ({url}): Error - Could not retrieve readable content"
            truncated = text[:AnthropicProvider.GROUNDING_CONTENT_CHAR_BUDGET]
            return f"--- START SOURCE: {url} ---\n{truncated}\n--- END SOURCE ---"
        except Exception as fetch_error:
            return f"Source ({url}): Failed to fetch due to error: {str(fetch_error)}"

    async def execute(self, request: AutomationRequest) -> AutomationResponse:
        inputs = request.get_inputs()

        system_prompts = []
        user_blocks = []
        links_to_fetch = []
        b_enable_search = False
        reasoning_effort = None
        response_schema_override = None
        max_output_tokens_override = None

        for content in inputs:
            metadata = content.get_metadata()
            data = content.get_data()
            content_type = content.get_content_type()

            if metadata and "search_results" in metadata:
                links = metadata["search_results"]
                if isinstance(links, list):
                    links_to_fetch.extend(links)

            if metadata and metadata.get("enable_search", False):
                b_enable_search = True

            # Reasoning-effort knob. Mirrors how thinking_level flows through
            # GoogleEnterpriseAiProvider: the caller sets it on any one content
            # part's metadata and the provider lifts it onto the request.
            if metadata and metadata.get("reasoning_effort"):
                reasoning_effort = metadata.get("reasoning_effort")

            if metadata and metadata.get("response_schema") is not None:
                response_schema_override = metadata.get("response_schema")
            if metadata and metadata.get("max_output_tokens") is not None:
                max_output_tokens_override = metadata.get("max_output_tokens")

            match content_type:
                case AutomationContentTypes.SYSTEM:
                    system_prompts.append(data)
                case AutomationContentTypes.TEXT:
                    user_blocks.append({"type": "text", "text": data})
                case AutomationContentTypes.IMAGE:
                    if isinstance(data, bytes):
                        user_blocks.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": base64.b64encode(data).decode("ascii"),
                            },
                        })

        if links_to_fetch:
            fetched = [await self.__fetch_url_content(link) for link in links_to_fetch]
            context_block = "\n\n".join([
                "THE FOLLOWING ARE VERIFIED CONTEXT SOURCES. USE THESE TO GROUND YOUR ANSWER:",
                *fetched
            ])
            user_blocks.insert(0, {"type": "text", "text": context_block})

        if not user_blocks:
            # The Messages API requires a non-empty first user turn; a request
            # built from system parts alone would 400. Fail with a message that
            # names the caller's mistake instead.
            raise ValueError("AnthropicProvider received no TEXT or IMAGE input — nothing to send as the user turn.")

        request_arguments = {
            "model": request.get_model(),
            "max_tokens": int(max_output_tokens_override or AnthropicProvider.DEFAULT_MAX_OUTPUT_TOKENS),
            "messages": [{"role": "user", "content": user_blocks}],
        }

        if system_prompts:
            request_arguments["system"] = "\n".join(system_prompts)

        output_config = {}
        if reasoning_effort is not None:
            output_config["effort"] = AnthropicProvider.__normalize_reasoning_effort(reasoning_effort)
        if response_schema_override is not None:
            output_config["format"] = {"type": "json_schema", "schema": response_schema_override}
        if output_config:
            request_arguments["output_config"] = output_config

        if b_enable_search:
            request_arguments["tools"] = [{
                "type": AnthropicProvider.WEB_SEARCH_TOOL_TYPE,
                "name": AnthropicProvider.WEB_SEARCH_TOOL_NAME,
            }]

        message = await self.__create_message_with_retry(request_arguments)

        # A safety classifier can decline the request: HTTP 200, stop_reason
        # "refusal", empty or partial content. Reading content[0] blindly here
        # would surface as a confusing downstream parse failure, so it is raised
        # as what it is. Never swallowed — a paid-deck stage that silently
        # produced nothing would leave a gap in the provenance trail.
        if getattr(message, "stop_reason", None) == "refusal":
            stop_details = getattr(message, "stop_details", None)
            refusal_category = getattr(stop_details, "category", None) if stop_details is not None else None
            raise RuntimeError(
                f"Anthropic declined the request on model {request.get_model()} "
                f"(stop_reason=refusal, category={refusal_category})."
            )

        collected_text = AnthropicProvider.__collect_text(message)

        # Truncation is the other way this call can "succeed" while returning
        # something unusable, and it is far quieter than a refusal: the response
        # is a normal HTTP 200 whose text simply stops mid-token once max_tokens
        # is exhausted. Nothing about the returned object says so except this
        # stop_reason.
        #
        # Left undetected, a caller expecting JSON gets a string that ends
        # halfway through an object, fails to parse it, and reports that the
        # MODEL produced a malformed shape — sending the reader after a prompt
        # or a schema when the real cause was the token budget. Raise instead,
        # naming the budget, so the fix is obvious. Deliberately not a silent
        # truncation-tolerant return: no caller here wants half an answer.
        if getattr(message, "stop_reason", None) == "max_tokens":
            raise RuntimeError(
                f"Anthropic response on model {request.get_model()} was cut off by the "
                f"max_tokens budget ({request_arguments['max_tokens']}); the returned text is "
                f"incomplete ({len(collected_text)} characters). On this model max_tokens caps "
                f"thinking plus the visible response together — raise the caller's "
                f"max_output_tokens metadata, or lower reasoning_effort so less of the "
                f"budget is spent thinking."
            )

        usage_metadata = CreditMeter.record_from_anthropic_response(
            message,
            model = request.get_model(),
            fallback_input_text = request.get_text_content(),
            fallback_output_text = collected_text,
        )

        outputs = []
        if collected_text:
            outputs.append(AutomationContent(AutomationContentTypes.TEXT, collected_text))

        return AutomationResponse(outputs, usage_metadata)

    @staticmethod
    def __normalize_reasoning_effort(reasoning_effort) -> str:
        """
        Accepts either a ReasoningEffortLevels value ("high") or its constant
        name ("HIGH"), so a caller reading the constant and a caller reading a
        stored provenance record both work. An unrecognised value raises rather
        than being silently dropped — a diagram generated at the default effort
        when the caller asked for high is exactly the failure this whole feature
        is trying to avoid, and it would be invisible.
        """
        if not isinstance(reasoning_effort, str):
            raise ValueError(f"reasoning_effort must be a string, got {type(reasoning_effort).__name__}.")

        candidate = reasoning_effort.strip()
        accepted_values = AnthropicProvider.__accepted_effort_values()

        if candidate in accepted_values:
            return candidate

        named_value = getattr(ReasoningEffortLevels, candidate.upper(), None)
        if isinstance(named_value, str) and named_value in accepted_values:
            return named_value

        raise ValueError(
            f"Unrecognised reasoning_effort '{reasoning_effort}'. "
            f"Expected one of {sorted(accepted_values)} (see ReasoningEffortLevels)."
        )

    @staticmethod
    def __accepted_effort_values() -> set:
        return {
            ReasoningEffortLevels.LOW,
            ReasoningEffortLevels.MEDIUM,
            ReasoningEffortLevels.HIGH,
            ReasoningEffortLevels.EXTRA_HIGH,
            ReasoningEffortLevels.MAXIMUM,
        }

    @staticmethod
    def __collect_text(message) -> str:
        """
        Concatenates every text block of the final message. Thinking blocks and
        server-tool blocks are skipped — callers want the answer, and the raw
        chain of thought is never returned by the API anyway.
        """
        text_parts = []
        for block in (getattr(message, "content", None) or []):
            if getattr(block, "type", None) == "text":
                block_text = getattr(block, "text", None)
                if block_text:
                    text_parts.append(block_text)
        return "".join(text_parts)

    async def __create_message_with_retry(self, request_arguments: dict):
        """
        Streams one message to completion, with the same two layers of
        protection against transient failures the Google provider uses:

        1. A cross-process Redis semaphore holds at most N slots per model
           (Common/Constants/ApiConcurrencyLimits.json), so every worker in the
           cluster cannot fire live calls in the same microsecond.

        2. Inside the slot, a 429 or 5xx sleeps and retries. Anthropic returns a
           Retry-After header on 429 which is honoured when present; otherwise
           the backoff is exponential. After MAX_TRANSIENT_RETRIES the original
           exception reaches the caller.

        Streaming (rather than a plain create) is used unconditionally so a long
        diagram or verification response cannot trip the SDK's HTTP timeout.
        """
        model = request_arguments["model"]
        attempt_index = 0

        while True:
            sleep_seconds = None
            async with RedisSemaphore.slot(
                bucket = model,
                max_concurrent = AnthropicProvider.__resolve_concurrent_limit(model),
                hold_timeout_seconds = ApiConcurrencyLimits.SLOT_HOLD_TIMEOUT_SECONDS,
                poll_interval_seconds = ApiConcurrencyLimits.ACQUIRE_POLL_INTERVAL_SECONDS,
            ):
                try:
                    async with self.__client.messages.stream(**request_arguments) as message_stream:
                        return await message_stream.get_final_message()
                except (anthropic.APIStatusError, anthropic.APIConnectionError) as api_error:
                    if not AnthropicProvider.__is_transient_error(api_error):
                        raise

                    error_label = AnthropicProvider.__describe_transient_error(api_error)

                    if attempt_index >= AnthropicProvider.MAX_TRANSIENT_RETRIES:
                        print(
                            f"[AnthropicProvider] {error_label} after {attempt_index} retries "
                            f"on model {model} — giving up."
                        )
                        raise

                    sleep_seconds = AnthropicProvider.__resolve_retry_delay_seconds(api_error, attempt_index)
                    print(
                        f"[AnthropicProvider] {error_label} on model {model} "
                        f"(attempt {attempt_index + 1}/{AnthropicProvider.MAX_TRANSIENT_RETRIES}). "
                        f"Sleeping {sleep_seconds:.1f}s then retrying."
                    )
                    await ProviderHealthSignal.mark_slowdown(error_label)

            # Sleep OUTSIDE the semaphore — the slot is already back in the pool,
            # so other workers can use it while this one backs off.
            if sleep_seconds is not None:
                await asyncio.sleep(sleep_seconds)
            attempt_index += 1

    @staticmethod
    def __resolve_concurrent_limit(model: str) -> int:
        return ApiConcurrencyLimits.MAX_CONCURRENT_BY_BUCKET.get(
            model,
            ApiConcurrencyLimits.DEFAULT_MAX_CONCURRENT,
        )

    # 429 is rate limit; 5xx are server-side capacity / internal errors; 408 is a
    # request timeout the SDK occasionally surfaces on slow streamed responses.
    # 529 is Anthropic's dedicated "overloaded" code.
    _TRANSIENT_STATUS_CODES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})

    @staticmethod
    def __is_transient_error(api_error) -> bool:
        # A connection error never reached the server, so replaying it is safe.
        if isinstance(api_error, anthropic.APIConnectionError):
            return True

        status_code = getattr(api_error, "status_code", None)
        return status_code in AnthropicProvider._TRANSIENT_STATUS_CODES

    @staticmethod
    def __describe_transient_error(api_error) -> str:
        if isinstance(api_error, anthropic.APIConnectionError):
            return "connection error"

        status_code = getattr(api_error, "status_code", None)
        if status_code == 429:
            return "429 rate_limit_error"
        if status_code == 529:
            return "529 overloaded_error"
        if status_code is not None:
            return f"{status_code} transient error"
        return "transient error"

    @staticmethod
    def __resolve_retry_delay_seconds(api_error, attempt_index: int) -> float:
        seconds = AnthropicProvider.__extract_retry_after_seconds(api_error)
        if seconds is None:
            # Exponential backoff anchored at DEFAULT_RETRY_SLEEP_SECONDS; the
            # per-minute token bucket refills in 60s so a few rounds suffice.
            seconds = AnthropicProvider.DEFAULT_RETRY_SLEEP_SECONDS * (2 ** attempt_index)
        return min(max(seconds, 1.0), AnthropicProvider.MAX_RETRY_SLEEP_SECONDS)

    @staticmethod
    def __extract_retry_after_seconds(api_error) -> float | None:
        """
        Reads the server-supplied Retry-After header off the failed response.
        Returns None when the header is absent or unparseable, in which case the
        caller falls back to exponential backoff.
        """
        response = getattr(api_error, "response", None)
        if response is None:
            return None

        headers = getattr(response, "headers", None)
        if headers is None:
            return None

        try:
            raw_value = headers.get("retry-after")
        except Exception:
            return None

        if not raw_value:
            return None

        try:
            return float(str(raw_value).strip())
        except (TypeError, ValueError):
            return None
