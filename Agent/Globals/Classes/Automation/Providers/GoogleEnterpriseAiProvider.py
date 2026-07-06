import os
import re
import sys
import json
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

import httpx
from google import genai
from google.genai import types
from google.genai import errors as genai_errors
from google.oauth2 import service_account


class GoogleEnterpriseAiProvider(AutomationProvider):
    """
    Google enterprise agent API provider.

    All live LLM traffic in the Agent service routes through this provider.
    It talks to Google's enterprise (Vertex) backend of the unified
    google-genai SDK, authenticating with a service account (preferred) or an
    API key (slow fallback). Every model tuple in ModelPool reads
    (model_string, ProviderClass), so a model routes here simply by naming
    this class.

    Two things differ from a Gemini-Developer-API provider and are the only
    semantic differences worth calling out:

      1. Client construction. The enterprise backend is selected with
         vertexai=True and authenticated with a project + service-account
         credentials (GOOGLE_ENTERPRISE_AGENT_PROJECT /
         GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64), falling back to an API
         key only when no project is set. See __build_client.

      2. Video inputs. The Files API (client.files.upload) is a
         Gemini-Developer-API-only feature; it is NOT available on the
         enterprise backend, which accepts media either inline (bytes) or
         as a gs:// GCS URI. We therefore read the local video into bytes
         and attach it inline. See __build_video_part.
    """

    GROUNDING_CONTENT_CHAR_BUDGET = 8000

    # Two classes of failure are treated as transient and retried with the
    # same backoff machinery:
    #
    #  - 429 RESOURCE_EXHAUSTED: rate / quota bucket drained. The API
    #    response carries a RetryInfo block with `retryDelay` (e.g.
    #    '3.957548552s') which we honour when present, otherwise we fall
    #    back to exponential backoff.
    #  - 5xx (UNAVAILABLE / INTERNAL / etc.): server-side capacity blip.
    #    No retry hint is supplied, so we use exponential backoff alone.
    #
    # The user has explicitly asked for "slow is fine, failure is not", so
    # the broader 5xx case opts into the same retry path rather than
    # surfacing as a task failure. We retry up to MAX_TRANSIENT_RETRIES
    # times and bound each sleep to MAX_RETRY_SLEEP_SECONDS so a
    # misbehaving server response can't pin us forever.
    MAX_TRANSIENT_RETRIES = 8
    DEFAULT_RETRY_SLEEP_SECONDS = 8.0
    MAX_RETRY_SLEEP_SECONDS = 60.0

    # Connecting to the Google endpoints via plain httpx on Windows runs
    # into a brutal IPv6 happy-eyeballs miss: the resolver hands back AAAA
    # records first, the connect to those addresses sits for ~80s before
    # timing out, and only THEN does httpx fall back to IPv4. Curl and the
    # browser don't see this because they connect to the v4/v6 candidates in
    # parallel. We sidestep the whole thing by binding the outbound socket
    # to 0.0.0.0, which forces the connect path to IPv4-only. Same trick
    # applied to the async transport so batch / streaming paths benefit too.
    __HTTPX_REQUEST_TIMEOUT_SECONDS = 60.0

    @staticmethod
    def __build_ipv4_httpx_clients() -> tuple[httpx.Client, httpx.AsyncClient]:
        timeout_config = httpx.Timeout(GoogleEnterpriseAiProvider.__HTTPX_REQUEST_TIMEOUT_SECONDS)
        sync_client    = httpx.Client(
            transport = httpx.HTTPTransport(local_address = "0.0.0.0"),
            timeout   = timeout_config,
        )
        async_client = httpx.AsyncClient(
            transport = httpx.AsyncHTTPTransport(local_address = "0.0.0.0"),
            timeout   = timeout_config,
        )
        return sync_client, async_client

    # Scope every Vertex AI call needs; a service-account key carries no scopes
    # of its own, so the broad cloud-platform scope is attached here.
    _VERTEX_CREDENTIAL_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)

    # Default Vertex region when GOOGLE_ENTERPRISE_AGENT_LOCATION is unset.
    DEFAULT_VERTEX_LOCATION = "global"

    @staticmethod
    def __build_client() -> genai.Client:
        """
        Builds a google-genai client bound to Google's enterprise (Vertex)
        backend. Two auth shapes are supported, checked in priority order:

          1. Service account / ADC — STRONGLY preferred. Selected by
             GOOGLE_ENTERPRISE_AGENT_PROJECT (the GCP project), with
             GOOGLE_ENTERPRISE_AGENT_LOCATION (region, default "global") and
             a service-account key in GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64
             (blank => ambient Application Default Credentials).

          2. API key (Vertex Express mode) — FALLBACK ONLY, used when no
             project is configured. Vertex's API-key path is ~5-6x slower to
             first token for streaming (~12s vs ~2s with a service account —
             confirmed in the AskAi latency investigation and reproduced
             upstream), so it exists only so an unmigrated environment keeps
             working, never as the intended path.

        The configuration is passed explicitly (rather than via the SDK's
        GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_CLOUD_* auto-discovery) so the wiring
        is readable and a misconfiguration fails loudly here.
        """
        sync_client, async_client = GoogleEnterpriseAiProvider.__build_ipv4_httpx_clients()
        http_options = types.HttpOptions(
            httpx_client       = sync_client,
            httpx_async_client = async_client,
        )

        project = os.getenv("GOOGLE_ENTERPRISE_AGENT_PROJECT")
        if project:
            location = os.getenv("GOOGLE_ENTERPRISE_AGENT_LOCATION") or GoogleEnterpriseAiProvider.DEFAULT_VERTEX_LOCATION
            client_arguments = {
                "vertexai":     True,
                "project":      project,
                "location":     location,
                "http_options": http_options,
            }
            credentials = GoogleEnterpriseAiProvider.__load_service_account_credentials()
            if credentials is not None:
                client_arguments["credentials"] = credentials
            return genai.Client(**client_arguments)

        api_key = os.getenv("GOOGLE_ENTERPRISE_AGENT_API_KEY")
        if api_key:
            return genai.Client(
                vertexai     = True,
                api_key      = api_key,
                http_options = http_options,
            )

        raise RuntimeError(
            "GoogleEnterpriseAiProvider requires either GOOGLE_ENTERPRISE_AGENT_PROJECT "
            "(with GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64 or ambient ADC), or the "
            "slow-fallback GOOGLE_ENTERPRISE_AGENT_API_KEY, to be set."
        )

    @staticmethod
    def __load_service_account_credentials():
        """
        Builds service-account credentials from the base64-encoded JSON key in
        GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64. Base64 (not a file path) is
        deliberate: the same value rides cleanly in the line-based env file AND
        is injected verbatim into each burst worker's env by BurstFleetSettings,
        so no key file ever has to exist on disk or be baked into an image.
        Returns None when unset, in which case the SDK falls back to ambient
        Application Default Credentials.
        """
        encoded = os.getenv("GOOGLE_ENTERPRISE_AGENT_CREDENTIALS_BASE64")
        if not encoded:
            return None
        service_account_info = json.loads(base64.b64decode(encoded))
        return service_account.Credentials.from_service_account_info(
            service_account_info,
            scopes = list(GoogleEnterpriseAiProvider._VERTEX_CREDENTIAL_SCOPES),
        )

    def __init__(self):
        self.__client = GoogleEnterpriseAiProvider.__build_client()

    async def __fetch_url_content(self, url: str) -> str:
        try:
            text = await WebContentFetcher.fetch_text_only(url)
            if not text:
                return f"Source ({url}): Error - Could not retrieve readable content"
            truncated = text[:GoogleEnterpriseAiProvider.GROUNDING_CONTENT_CHAR_BUDGET]
            return f"--- START SOURCE: {url} ---\n{truncated}\n--- END SOURCE ---"
        except Exception as fetch_error:
            return f"Source ({url}): Failed to fetch due to error: {str(fetch_error)}"

    @staticmethod
    async def __build_video_part(video_path: str, mime_type: str) -> types.Part:
        """
        The enterprise backend has no Files API, so we attach the video
        inline. The file is read off the worker thread to avoid blocking the
        event loop. Inline media is subject to the per-request payload
        ceiling; oversized clips should be staged in GCS and referenced via
        a gs:// URI by the calling workflow instead.
        """
        video_bytes = await asyncio.to_thread(GoogleEnterpriseAiProvider.__read_file_bytes, video_path)
        return types.Part.from_bytes(data = video_bytes, mime_type = mime_type)

    @staticmethod
    def __read_file_bytes(file_path: str) -> bytes:
        with open(file_path, "rb") as file_handle:
            return file_handle.read()

    async def execute(self, request: AutomationRequest) -> AutomationResponse:
        inputs = request.get_inputs()

        system_prompts = []
        user_parts = []
        links_to_fetch = []
        enable_search  = False
        generate_image = False
        image_aspect_ratio = None
        thinking_level = None
        response_as_text = False
        response_schema_override = None
        temperature_override = None
        max_output_tokens_override = None

        for content in inputs:
            metadata = content.get_metadata()
            data     = content.get_data()
            ctype    = content.get_content_type()

            if metadata and "search_results" in metadata:
                links = metadata["search_results"]
                if isinstance(links, list):
                    links_to_fetch.extend(links)

            if metadata and metadata.get("enable_search", False):
                enable_search = True
            if metadata and metadata.get("generate_image", False):
                generate_image = True
            if metadata and metadata.get("image_aspect_ratio"):
                image_aspect_ratio = metadata.get("image_aspect_ratio")
            if metadata and metadata.get("thinking_level"):
                thinking_level = metadata.get("thinking_level")
            if metadata and metadata.get("response_as_text", False):
                response_as_text = True

            # Opt-in structured-output knobs. Only the EnhanceImages
            # workflow uses these today (Pydantic schema enforcement
            # for the diagram-extraction stage); every existing caller
            # is unaffected because the fields default to None.
            if metadata and metadata.get("response_schema") is not None:
                response_schema_override = metadata.get("response_schema")
            if metadata and metadata.get("temperature") is not None:
                temperature_override = metadata.get("temperature")
            if metadata and metadata.get("max_output_tokens") is not None:
                max_output_tokens_override = metadata.get("max_output_tokens")

            match ctype:
                case AutomationContentTypes.SYSTEM:
                    system_prompts.append(data)
                case AutomationContentTypes.TEXT:
                    user_parts.append(types.Part.from_text(text=data))
                case AutomationContentTypes.IMAGE:
                    if isinstance(data, bytes):
                        user_parts.append(types.Part.from_bytes(data=data, mime_type="image/png"))
                case AutomationContentTypes.AUDIO:
                    if isinstance(data, bytes):
                        user_parts.append(types.Part.from_bytes(data=data, mime_type="audio/wav"))
                case AutomationContentTypes.VIDEO:
                    if isinstance(data, str):
                        mime_type = metadata.get("mime_type", "video/mp4") if metadata else "video/mp4"
                        user_parts.append(await GoogleEnterpriseAiProvider.__build_video_part(data, mime_type))

        if links_to_fetch:
            fetched = [await self.__fetch_url_content(link) for link in links_to_fetch]
            context_block = "\n\n".join([
                "THE FOLLOWING ARE VERIFIED CONTEXT SOURCES. USE THESE TO GROUND YOUR ANSWER:",
                *fetched
            ])
            user_parts.insert(0, types.Part.from_text(text=context_block))

        config_args = {}

        if system_prompts:
            config_args["system_instruction"] = "\n".join(system_prompts)

        if generate_image:
            return await self.__fetch_image_generation(request, user_parts, config_args, thinking_level, image_aspect_ratio)

        config_args["response_mime_type"] = "text/plain" if response_as_text else "application/json"

        if response_schema_override is not None:
            config_args["response_schema"] = response_schema_override

        if temperature_override is not None:
            config_args["temperature"] = temperature_override

        if max_output_tokens_override is not None:
            config_args["max_output_tokens"] = max_output_tokens_override

        if enable_search:
            config_args["tools"] = [types.Tool(google_search=types.GoogleSearch())]

        config = types.GenerateContentConfig(**config_args)

        response = await self.__generate_content_with_retry(
            model = request.get_model(),
            contents = user_parts,
            config = config,
        )

        # Capture token usage into the process-global meter so the credit
        # system can apply per-token spend rules for this task. The prompt and
        # response text are passed as a chars/4 fallback for the rare case the
        # response carries no usage_metadata.
        usage_metadata = GoogleEnterpriseAiProvider.__record_token_usage(
            response,
            request.get_model(),
            request.get_text_content(),
            GoogleEnterpriseAiProvider.__safe_response_text(response),
        )

        outputs = []
        if response.text:
            outputs.append(AutomationContent(AutomationContentTypes.TEXT, response.text))

        if hasattr(response, "candidates"):
            for candidate in response.candidates:
                if hasattr(candidate, "content"):
                    for part in candidate.content.parts:
                        if hasattr(part, "inline_data") and part.inline_data:
                            if part.inline_data.mime_type.startswith("image"):
                                outputs.append(AutomationContent(
                                    AutomationContentTypes.IMAGE,
                                    base64.b64decode(part.inline_data.data)
                                ))

        return AutomationResponse(outputs, usage_metadata)

    @staticmethod
    def __safe_response_text(response) -> str | None:
        # response.text is a property that can raise (not just return None) when
        # the response carries no usable parts — and it is only needed as a
        # token-estimate fallback — so any failure collapses to None.
        try:
            return response.text
        except Exception:
            return None

    @staticmethod
    def __record_token_usage(response, model, fallback_input_text, fallback_output_text) -> dict:
        # Delegates to the shared meter so the live, batch and image paths
        # all extract usage identically. The model drives cost-normalization;
        # the fallback texts cover responses that omit usage_metadata.
        return CreditMeter.record_from_response(
            response,
            model = model,
            fallback_input_text = fallback_input_text,
            fallback_output_text = fallback_output_text,
        )

    async def stream_text(
        self,
        *,
        model: str,
        system_prompt: str,
        user_prompt: str,
        attached_image_parts: list,
        b_enable_google_search: bool,
    ):
        """
        Async generator that streams an enterprise-backend text response
        chunk-by-chunk. Designed for the AskAi feature on the Study page —
        the caller forwards each yielded event straight to the browser as one
        NDJSON line.

        Yielded events (each a JSON-serialisable dict):
            { "type": "text", "value": "..." }                  - 0 or more
            { "type": "citations", "sources": [...] }           - 0 or 1, only when google-search grounding fires
            { "type": "error", "message": "..." }               - 0 or 1, on non-transient failure
            (The "done" sentinel is the caller's responsibility — this
             generator simply returns when the stream ends.)

        Retry semantics: transient failures (429 / 5xx / DEADLINE_EXCEEDED)
        that occur BEFORE the first token is yielded retry the whole stream
        up to MAX_TRANSIENT_RETRIES, mirroring the __generate_content_with_retry
        path. Failures that occur AFTER any text has been emitted surface
        as an error event and terminate the stream — we can't replay tokens
        we've already shipped to the browser.

        The Redis semaphore is held for the lifetime of the stream so per-
        model concurrency caps apply to streaming calls too.
        """
        user_text_part = types.Part.from_text(text=user_prompt)
        contents = [user_text_part, *attached_image_parts]

        # AskAi is real-time — the user is watching tokens stream in.
        # Without an explicit thinking_budget, the flash-lite tier spends
        # tens of seconds in its thinking phase before emitting any output,
        # which presents as a stuck "Thinking…" dialog on the client.
        # Using thinking_budget=0 disables the thinking phase entirely (the
        # SDK docstring: "0 is DISABLED. -1 is AUTOMATIC."), which keeps
        # first-chunk latency at the usual few hundred ms. The AI Studio
        # sample uses thinking_level=MINIMAL, but that enum value is
        # silently ignored by 2.5-flash-lite — only thinking_budget takes
        # effect on this model family.
        config_args = {
            "system_instruction":   system_prompt,
            "response_mime_type":   "text/plain",
            "thinking_config":      types.ThinkingConfig(thinking_budget=0),
        }
        if b_enable_google_search:
            config_args["tools"] = [types.Tool(google_search=types.GoogleSearch())]

        config = types.GenerateContentConfig(**config_args)

        attempt_index = 0
        while True:
            sleep_seconds = None
            b_yielded_any_text = False
            last_seen_chunk = None

            try:
                async with RedisSemaphore.slot(
                    bucket = model,
                    max_concurrent = GoogleEnterpriseAiProvider.__resolve_concurrent_limit(model),
                    hold_timeout_seconds = ApiConcurrencyLimits.SLOT_HOLD_TIMEOUT_SECONDS,
                    poll_interval_seconds = ApiConcurrencyLimits.ACQUIRE_POLL_INTERVAL_SECONDS,
                ):
                    stream_iterator = await asyncio.to_thread(
                        self.__client.models.generate_content_stream,
                        model = model,
                        contents = contents,
                        config = config,
                    )

                    sentinel = object()
                    while True:
                        next_chunk = await asyncio.to_thread(next, stream_iterator, sentinel)
                        if next_chunk is sentinel:
                            break
                        last_seen_chunk = next_chunk

                        chunk_text = getattr(next_chunk, "text", None)
                        if chunk_text:
                            b_yielded_any_text = True
                            yield { "type": "text", "value": chunk_text }

                    GoogleEnterpriseAiProvider.__log_stream_usage(last_seen_chunk, model)

                    citation_sources = GoogleEnterpriseAiProvider.__extract_citation_sources(last_seen_chunk)
                    if citation_sources:
                        yield { "type": "citations", "sources": citation_sources }

                    return

            except (genai_errors.ClientError, genai_errors.ServerError) as api_error:
                if not GoogleEnterpriseAiProvider.__is_transient_error(api_error):
                    yield { "type": "error", "message": str(api_error) }
                    return

                if b_yielded_any_text:
                    # Mid-stream transient failure — we've already shipped
                    # tokens to the browser; replaying would duplicate
                    # content. Surface the failure and stop.
                    yield { "type": "error", "message": f"Stream interrupted: {api_error}" }
                    return

                error_label = GoogleEnterpriseAiProvider.__describe_transient_error(api_error)
                if attempt_index >= GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES:
                    print(
                        f"[GoogleEnterpriseAiProvider] stream_text {error_label} after "
                        f"{attempt_index} retries on model {model} — giving up."
                    )
                    yield { "type": "error", "message": str(api_error) }
                    return

                sleep_seconds = GoogleEnterpriseAiProvider.__resolve_retry_delay_seconds(api_error, attempt_index)
                print(
                    f"[GoogleEnterpriseAiProvider] stream_text {error_label} on model {model} "
                    f"(attempt {attempt_index + 1}/{GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES}). "
                    f"Sleeping {sleep_seconds:.1f}s then retrying."
                )
                await ProviderHealthSignal.mark_slowdown(error_label)

            except Exception as unexpected_error:
                yield { "type": "error", "message": str(unexpected_error) }
                return

            if sleep_seconds is not None:
                await asyncio.sleep(sleep_seconds)
            attempt_index += 1

    @staticmethod
    def __log_stream_usage(final_chunk, model: str) -> None:
        """
        Emit the streamed response's token accounting to stderr (Dock tees the
        AskAi worker's stderr into the server log as AGENT:ASK_AI). The
        decisive field for AskAi latency is thoughts_token_count: a large value
        means this reasoning model spent its budget "thinking" before the first
        token — i.e. the thing to suppress. Deliberately written to stderr, never
        stdout, so it can never pollute the worker's NDJSON event stream.
        """
        usage = getattr(final_chunk, "usage_metadata", None)
        if usage is None:
            print(f"[GoogleEnterpriseAiProvider] [TOKEN_USAGE] model={model} usage_metadata=None (no accounting on final chunk)", file=sys.stderr, flush=True)
            return
        print(
            f"[GoogleEnterpriseAiProvider] [TOKEN_USAGE] model={model} "
            f"prompt={getattr(usage, 'prompt_token_count', None)} "
            f"candidates={getattr(usage, 'candidates_token_count', None)} "
            f"thoughts={getattr(usage, 'thoughts_token_count', None)} "
            f"cached={getattr(usage, 'cached_content_token_count', None)} "
            f"total={getattr(usage, 'total_token_count', None)}",
            file=sys.stderr, flush=True,
        )

    @staticmethod
    def __extract_citation_sources(final_chunk) -> list[dict]:
        """
        Pulls the {uri, title} list out of the final stream chunk's
        grounding metadata when google-search grounding fired. Returns
        an empty list when the chunk has no grounding info or the call
        wasn't grounded.
        """
        if final_chunk is None:
            return []

        candidates = getattr(final_chunk, "candidates", None) or []
        for candidate in candidates:
            grounding_metadata = getattr(candidate, "grounding_metadata", None)
            if grounding_metadata is None:
                continue
            grounding_chunks = getattr(grounding_metadata, "grounding_chunks", None) or []
            collected_sources = []
            for grounding_chunk in grounding_chunks:
                web_info = getattr(grounding_chunk, "web", None)
                if web_info is None:
                    continue
                source_uri   = getattr(web_info, "uri", None)
                source_title = getattr(web_info, "title", None)
                if source_uri:
                    collected_sources.append({ "uri": source_uri, "title": source_title or source_uri })
            if collected_sources:
                return collected_sources
        return []

    async def __generate_content_with_retry(self, model: str, contents, config):
        """
        Calls generate_content with two layers of protection against
        transient failures (429 RESOURCE_EXHAUSTED and 5xx
        UNAVAILABLE/INTERNAL):

        1. A cross-process Redis semaphore holds open at most N slots per
           model (configured in Common/Constants/ApiConcurrencyLimits.json).
           This is the primary defense: it stops every worker in the
           cluster from firing live calls in the same microsecond.

        2. Inside the slot we run the actual call. If the API still
           returns a transient error — 429 (quota share / rough TPM
           estimate exceeded) or 5xx (server-side capacity blip) — we
           sleep and retry. 429 responses carry a server-supplied
           retryDelay we honour; 5xx have no retry hint so we use
           exponential backoff. After MAX_TRANSIENT_RETRIES the caller
           is informed via the original exception.
        """
        attempt_index = 0
        while True:
            sleep_seconds = None
            async with RedisSemaphore.slot(
                bucket = model,
                max_concurrent = GoogleEnterpriseAiProvider.__resolve_concurrent_limit(model),
                hold_timeout_seconds = ApiConcurrencyLimits.SLOT_HOLD_TIMEOUT_SECONDS,
                poll_interval_seconds = ApiConcurrencyLimits.ACQUIRE_POLL_INTERVAL_SECONDS,
            ):
                try:
                    return await asyncio.to_thread(
                        self.__client.models.generate_content,
                        model = model,
                        contents = contents,
                        config = config,
                    )
                except (genai_errors.ClientError, genai_errors.ServerError) as api_error:
                    if not GoogleEnterpriseAiProvider.__is_transient_error(api_error):
                        raise

                    error_label = GoogleEnterpriseAiProvider.__describe_transient_error(api_error)

                    if attempt_index >= GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES:
                        print(
                            f"[GoogleEnterpriseAiProvider] {error_label} after "
                            f"{attempt_index} retries on model {model} — giving up."
                        )
                        raise

                    sleep_seconds = GoogleEnterpriseAiProvider.__resolve_retry_delay_seconds(api_error, attempt_index)
                    print(
                        f"[GoogleEnterpriseAiProvider] {error_label} on model {model} "
                        f"(attempt {attempt_index + 1}/{GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES}). "
                        f"Sleeping {sleep_seconds:.1f}s then retrying."
                    )
                    await ProviderHealthSignal.mark_slowdown(error_label)

            # Sleep is OUTSIDE the semaphore — we have already released
            # the slot back to the pool, so other workers can use it
            # while we back off.
            if sleep_seconds is not None:
                await asyncio.sleep(sleep_seconds)
            attempt_index += 1

    @staticmethod
    def __resolve_concurrent_limit(model: str) -> int:
        return ApiConcurrencyLimits.MAX_CONCURRENT_BY_BUCKET.get(
            model,
            ApiConcurrencyLimits.DEFAULT_MAX_CONCURRENT,
        )

    # Status codes treated as transient. 429 is quota; 5xx are
    # server-side capacity / internal errors. Both retry on the same
    # exponential backoff path. 408 (request timeout) joins them since
    # the SDK occasionally surfaces it for slow streamed responses.
    _TRANSIENT_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})

    # Substring fallbacks for SDK versions that don't populate the
    # numeric code on the exception (we've seen both shapes in the wild).
    _TRANSIENT_STATUS_KEYWORDS = (
        "RESOURCE_EXHAUSTED",
        "UNAVAILABLE",
        "INTERNAL",
        "DEADLINE_EXCEEDED",
    )

    @staticmethod
    def __is_transient_error(api_error) -> bool:
        status_code = getattr(api_error, "code", None)
        if status_code in GoogleEnterpriseAiProvider._TRANSIENT_STATUS_CODES:
            return True

        stringified_error = str(api_error)
        for transient_keyword in GoogleEnterpriseAiProvider._TRANSIENT_STATUS_KEYWORDS:
            if transient_keyword in stringified_error:
                return True

        return False

    @staticmethod
    def __describe_transient_error(api_error) -> str:
        status_code = getattr(api_error, "code", None)
        stringified_error = str(api_error)

        if status_code == 429 or "RESOURCE_EXHAUSTED" in stringified_error:
            return "429 RESOURCE_EXHAUSTED"
        if status_code == 503 or "UNAVAILABLE" in stringified_error:
            return "503 UNAVAILABLE"
        if status_code == 500 or "INTERNAL" in stringified_error:
            return "500 INTERNAL"
        if status_code == 504 or "DEADLINE_EXCEEDED" in stringified_error:
            return "504 DEADLINE_EXCEEDED"
        if status_code is not None:
            return f"{status_code} transient error"
        return "transient error"

    @staticmethod
    def __resolve_retry_delay_seconds(client_error, attempt_index: int) -> float:
        seconds = GoogleEnterpriseAiProvider.__extract_retry_delay_from_error(client_error)
        if seconds is None:
            # Exponential backoff anchored at DEFAULT_RETRY_SLEEP_SECONDS.
            # Doubles each attempt; the per-minute TPM bucket refills in
            # 60s so a few rounds is typically enough.
            seconds = GoogleEnterpriseAiProvider.DEFAULT_RETRY_SLEEP_SECONDS * (2 ** attempt_index)
        return min(max(seconds, 1.0), GoogleEnterpriseAiProvider.MAX_RETRY_SLEEP_SECONDS)

    @staticmethod
    def __extract_retry_delay_from_error(client_error) -> float | None:
        # Try structured details first (the Google SDK exposes the raw
        # error payload via .details / .response_json depending on the
        # version). Fall back to a regex on the stringified error if the
        # structured path is unavailable.
        for attribute_name in ("details", "response_json"):
            attribute_value = getattr(client_error, attribute_name, None)
            if attribute_value is None:
                continue
            error_payload = attribute_value
            if isinstance(error_payload, dict):
                error_block = error_payload.get("error", error_payload)
                for detail_entry in error_block.get("details", []) or []:
                    if detail_entry.get("@type", "").endswith("RetryInfo"):
                        delay_string = detail_entry.get("retryDelay", "")
                        parsed = GoogleEnterpriseAiProvider.__parse_duration_string(delay_string)
                        if parsed is not None:
                            return parsed

        regex_match = re.search(r"retryDelay['\"]?\s*:\s*['\"]?([0-9.]+)s", str(client_error))
        if regex_match:
            try:
                return float(regex_match.group(1))
            except ValueError:
                return None
        return None

    @staticmethod
    def __parse_duration_string(duration_string: str) -> float | None:
        if not isinstance(duration_string, str):
            return None
        match = re.match(r"^([0-9.]+)s$", duration_string.strip())
        if not match:
            return None
        try:
            return float(match.group(1))
        except ValueError:
            return None

    async def __stream_image_with_retry(self, model: str, contents, config) -> dict[int, bytearray]:
        """
        Streams generate_content_stream into image_buffers, retrying the
        whole stream on transient errors. Buffers are reset between
        attempts so a partial payload from a failed attempt cannot
        contaminate the next attempt's data.
        """
        attempt_index = 0

        while True:
            sleep_seconds = None
            image_buffers: dict[int, bytearray] = {}

            async with RedisSemaphore.slot(
                bucket = model,
                max_concurrent = GoogleEnterpriseAiProvider.__resolve_concurrent_limit(model),
                hold_timeout_seconds = ApiConcurrencyLimits.SLOT_HOLD_TIMEOUT_SECONDS,
                poll_interval_seconds = ApiConcurrencyLimits.ACQUIRE_POLL_INTERVAL_SECONDS,
            ):
                def stream_sync():
                    last_chunk = None
                    for chunk in self.__client.models.generate_content_stream(
                        model = model,
                        contents = contents,
                        config = config,
                    ):
                        last_chunk = chunk
                        if chunk.parts is None:
                            continue
                        for part in chunk.parts:
                            if part.inline_data and part.inline_data.data:
                                buf = image_buffers.setdefault(0, bytearray())
                                buf.extend(part.inline_data.data)
                            elif hasattr(part, "text") and part.text:
                                print(f"[GoogleEnterpriseAiProvider] stream text: {part.text}")

                    # The final stream chunk carries the usage_metadata for the
                    # whole image generation; record it for per-token billing.
                    if last_chunk is not None:
                        CreditMeter.record_from_response(last_chunk, model = model)

                try:
                    await asyncio.to_thread(stream_sync)
                    return image_buffers
                except (genai_errors.ClientError, genai_errors.ServerError) as api_error:
                    if not GoogleEnterpriseAiProvider.__is_transient_error(api_error):
                        raise

                    error_label = GoogleEnterpriseAiProvider.__describe_transient_error(api_error)

                    if attempt_index >= GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES:
                        print(
                            f"[GoogleEnterpriseAiProvider] {error_label} after "
                            f"{attempt_index} retries on image stream (model {model}) — giving up."
                        )
                        raise

                    sleep_seconds = GoogleEnterpriseAiProvider.__resolve_retry_delay_seconds(api_error, attempt_index)
                    print(
                        f"[GoogleEnterpriseAiProvider] {error_label} on image stream (model {model}, "
                        f"attempt {attempt_index + 1}/{GoogleEnterpriseAiProvider.MAX_TRANSIENT_RETRIES}). "
                        f"Sleeping {sleep_seconds:.1f}s then retrying."
                    )
                    await ProviderHealthSignal.mark_slowdown(error_label)

            if sleep_seconds is not None:
                await asyncio.sleep(sleep_seconds)
            attempt_index += 1

    async def __fetch_image_generation(
        self,
        request:            AutomationRequest,
        user_parts:         list,
        config_args:        dict,
        thinking_level:     str | None = None,
        image_aspect_ratio: str | None = None,
    ) -> AutomationResponse:
        if "system_instruction" in config_args:
            config_args["system_instruction"] = [types.Part.from_text(text=config_args.pop("system_instruction"))]

        image_config_arguments = {"image_size": "1K"}
        if image_aspect_ratio is not None:
            image_config_arguments["aspect_ratio"] = image_aspect_ratio

        config_args["thinking_config"]     = types.ThinkingConfig(thinking_level=thinking_level or "HIGH")
        config_args["image_config"]        = types.ImageConfig(**image_config_arguments)
        config_args["response_modalities"] = ["IMAGE"]

        config   = types.GenerateContentConfig(**config_args)
        contents = [types.Content(role="user", parts=user_parts)]

        print(f"[GoogleEnterpriseAiProvider] Starting image generation stream (model={request.get_model()})...")

        # The streaming endpoint hits the same transient-error surface as
        # generate_content (429 / 5xx). Mirror the retry policy of
        # __generate_content_with_retry so EnhanceImages survives a
        # server-side capacity blip mid-batch instead of failing the task.
        image_buffers: dict[int, bytearray] = await self.__stream_image_with_retry(
            model = request.get_model(),
            contents = contents,
            config = config,
        )

        if not image_buffers:
            print("[GoogleEnterpriseAiProvider] Image generation stream produced no image data")
            return AutomationResponse([])

        outputs = [
            AutomationContent(AutomationContentTypes.IMAGE, bytes(buf))
            for buf in image_buffers.values()
        ]

        print(f"[GoogleEnterpriseAiProvider] Image generation complete — {len(outputs)} image(s), "
              f"{sum(len(b) for b in image_buffers.values()):,} bytes total")

        return AutomationResponse(outputs)
