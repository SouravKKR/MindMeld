import os
import re
import asyncio
import base64

from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Generic.RedisSemaphore import RedisSemaphore
from Globals.Classes.WebScraping.WebContentFetcher import WebContentFetcher
from Globals.Constants.ApiConcurrencyLimits import ApiConcurrencyLimits

from google import genai
from google.genai import types
from google.genai import errors as genai_errors


class GeminiProvider(AutomationProvider):
    GROUNDING_CONTENT_CHAR_BUDGET = 8000

    # When the API responds with 429 RESOURCE_EXHAUSTED it includes a
    # RetryInfo block with `retryDelay` (e.g. '3.957548552s'). Honour the
    # server's suggested delay and retry — the user has explicitly asked
    # for "slow is fine, failure is not", and 429 is by definition
    # transient (some other call drained the bucket; it refills in
    # seconds). We retry up to MAX_RATE_LIMIT_RETRIES times and bound
    # each sleep to MAX_RETRY_SLEEP_SECONDS so a misbehaving server
    # response can't pin us forever.
    MAX_RATE_LIMIT_RETRIES = 8
    DEFAULT_RETRY_SLEEP_SECONDS = 8.0
    MAX_RETRY_SLEEP_SECONDS = 60.0

    def __init__(self):
        self.__client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

    async def __fetch_url_content(self, url: str) -> str:
        try:
            text = await WebContentFetcher.fetch_text_only(url)
            if not text:
                return f"Source ({url}): Error - Could not retrieve readable content"
            truncated = text[:GeminiProvider.GROUNDING_CONTENT_CHAR_BUDGET]
            return f"--- START SOURCE: {url} ---\n{truncated}\n--- END SOURCE ---"
        except Exception as fetch_error:
            return f"Source ({url}): Failed to fetch due to error: {str(fetch_error)}"

    async def __upload_video(self, video_path: str, mime_type: str) -> types.File:
        uploaded_file = await asyncio.to_thread(
            self.__client.files.upload,
            file=video_path,
            config=types.UploadFileConfig(mime_type=mime_type)
        )
        while uploaded_file.state.name == "PROCESSING":
            await asyncio.sleep(2)
            uploaded_file = await asyncio.to_thread(self.__client.files.get, name=uploaded_file.name)
        return uploaded_file

    async def execute(self, request: AutomationRequest) -> AutomationResponse:
        inputs = request.get_inputs()

        system_prompts = []
        user_parts = []
        links_to_fetch = []
        enable_search  = False
        generate_image = False
        thinking_level = None
        response_as_text = False

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
            if metadata and metadata.get("thinking_level"):
                thinking_level = metadata.get("thinking_level")
            if metadata and metadata.get("response_as_text", False):
                response_as_text = True

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
                        uploaded_file = await self.__upload_video(data, mime_type)
                        user_parts.append(types.Part.from_uri(file_uri=uploaded_file.uri, mime_type=mime_type))

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
            return await self.__fetch_image_generation(request, user_parts, config_args, thinking_level)

        config_args["response_mime_type"] = "text/plain" if response_as_text else "application/json"

        if enable_search:
            config_args["tools"] = [types.Tool(google_search=types.GoogleSearch())]

        config = types.GenerateContentConfig(**config_args)

        response = await self.__generate_content_with_retry(
            model = request.get_model(),
            contents = user_parts,
            config = config,
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

        return AutomationResponse(outputs)

    async def __generate_content_with_retry(self, model: str, contents, config):
        """
        Calls Gemini generate_content with two layers of protection against
        RESOURCE_EXHAUSTED:

        1. A cross-process Redis semaphore holds open at most N slots per
           model (configured in Common/Constants/ApiConcurrencyLimits.json).
           This is the primary defense: it stops every worker in the
           cluster from firing live calls in the same microsecond.

        2. Inside the slot we run the actual call. If the API still
           returns 429 — possible if other consumers of the same API key
           are sharing the quota, or the in-flight tokens exceed our
           rough estimate — we honour the server-supplied retryDelay,
           sleep, and retry. After MAX_RATE_LIMIT_RETRIES the caller is
           informed via the original exception.
        """
        attempt_index = 0
        while True:
            sleep_seconds = None
            async with RedisSemaphore.slot(
                bucket = model,
                max_concurrent = GeminiProvider.__resolve_concurrent_limit(model),
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
                except genai_errors.ClientError as client_error:
                    if not GeminiProvider.__is_rate_limit_error(client_error):
                        raise

                    if attempt_index >= GeminiProvider.MAX_RATE_LIMIT_RETRIES:
                        print(
                            f"[GeminiProvider] 429 RESOURCE_EXHAUSTED after "
                            f"{attempt_index} retries on model {model} — giving up."
                        )
                        raise

                    sleep_seconds = GeminiProvider.__resolve_retry_delay_seconds(client_error, attempt_index)
                    print(
                        f"[GeminiProvider] 429 RESOURCE_EXHAUSTED on model {model} "
                        f"(attempt {attempt_index + 1}/{GeminiProvider.MAX_RATE_LIMIT_RETRIES}). "
                        f"Sleeping {sleep_seconds:.1f}s then retrying."
                    )

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

    @staticmethod
    def __is_rate_limit_error(client_error) -> bool:
        status_code = getattr(client_error, "code", None)
        if status_code == 429:
            return True
        return "RESOURCE_EXHAUSTED" in str(client_error)

    @staticmethod
    def __resolve_retry_delay_seconds(client_error, attempt_index: int) -> float:
        seconds = GeminiProvider.__extract_retry_delay_from_error(client_error)
        if seconds is None:
            # Exponential backoff anchored at DEFAULT_RETRY_SLEEP_SECONDS.
            # Doubles each attempt; the per-minute TPM bucket refills in
            # 60s so a few rounds is typically enough.
            seconds = GeminiProvider.DEFAULT_RETRY_SLEEP_SECONDS * (2 ** attempt_index)
        return min(max(seconds, 1.0), GeminiProvider.MAX_RETRY_SLEEP_SECONDS)

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
                        parsed = GeminiProvider.__parse_duration_string(delay_string)
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

    async def __fetch_image_generation(
        self,
        request:        AutomationRequest,
        user_parts:     list,
        config_args:    dict,
        thinking_level: str | None = None,
    ) -> AutomationResponse:
        if "system_instruction" in config_args:
            config_args["system_instruction"] = [types.Part.from_text(text=config_args.pop("system_instruction"))]

        config_args["thinking_config"]     = types.ThinkingConfig(thinking_level=thinking_level or "HIGH")
        config_args["image_config"]        = types.ImageConfig(image_size="2K")
        config_args["response_modalities"] = ["IMAGE"]

        config   = types.GenerateContentConfig(**config_args)
        contents = [types.Content(role="user", parts=user_parts)]

        print(f"[GeminiProvider] Starting image generation stream (model={request.get_model()})...")

        image_buffers: dict[int, bytearray] = {}

        def stream_sync():
            for chunk in self.__client.models.generate_content_stream(
                model=request.get_model(),
                contents=contents,
                config=config,
            ):
                if chunk.parts is None:
                    continue
                for part in chunk.parts:
                    if part.inline_data and part.inline_data.data:
                        buf = image_buffers.setdefault(0, bytearray())
                        buf.extend(part.inline_data.data)
                    elif hasattr(part, "text") and part.text:
                        print(f"[GeminiProvider] stream text: {part.text}")

        await asyncio.to_thread(stream_sync)

        if not image_buffers:
            print("[GeminiProvider] Image generation stream produced no image data")
            return AutomationResponse([])

        outputs = [
            AutomationContent(AutomationContentTypes.IMAGE, bytes(buf))
            for buf in image_buffers.values()
        ]

        print(f"[GeminiProvider] Image generation complete — {len(outputs)} image(s), "
              f"{sum(len(b) for b in image_buffers.values()):,} bytes total")

        return AutomationResponse(outputs)
