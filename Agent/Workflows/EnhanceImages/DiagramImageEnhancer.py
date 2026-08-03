import asyncio
import base64
import os

import openai
from openai import AsyncOpenAI

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
from Globals.Classes.Automation.ProviderHealthSignal import ProviderHealthSignal
from Globals.Classes.Credits.CreditMeter import CreditMeter
from Globals.Constants.ModelPricing import ModelPricing
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes


class DiagramImageEnhancer:
    """
    Re-expresses an extracted figure for use in study decks (paid included)
    without reproducing the copyrighted visual expression of the source.

    Legal basis: facts (labels, connections, structure) are not copyrightable
    (Feist doctrine). The enhancer therefore works in two steps and NEVER passes
    the source image to the image-generation step:

      1. DESCRIBE -- Gemini reads the figure into an exhaustive prose description
         of its facts (entities, labels, connections, structure). The source
         image is seen only here, only to extract those facts as words.
      2. GENERATE -- GPT-Image generates a wholly new image from that prose
         description alone. Because it never sees the original, its output is an
         original re-expression of the facts, not a copy.

    enhance() returns one of:
      {"kind": "DIAGRAM_IMAGE_PNG", "image_bytes": <bytes>, "renderer": "gemini-gpt-image"}
      {"kind": "DIAGRAM_FALLBACK_ORIGINAL"}   (describe or generate failed)
    """

    GEMINI_DESCRIBE_MODEL_NAME = "gemini-3.1-flash-lite"
    GPT_IMAGE_MODEL_NAME = "gpt-image-2"
    GPT_IMAGE_SIZE = "1024x1024"
    GPT_IMAGE_QUALITY = "low"

    # Per-call bound on the GPT-Image generation request so a stuck socket
    # surfaces as a caught error rather than hanging the enhance stage
    # indefinitely. This is the SDK's own per-attempt retry; the transient-retry
    # loop below sits outside it and is what actually rides out a rate limit.
    OPENAI_REQUEST_TIMEOUT_SECONDS = 120
    OPENAI_MAX_RETRIES = 2

    # Transient-failure policy for the image endpoint, deliberately identical in
    # shape to GoogleEnterpriseAiProvider / AnthropicProvider: 429 (rate limit)
    # and 5xx (capacity) are retried with backoff, honouring Retry-After when the
    # server supplies it. "Slow is fine, failure is not."
    #
    # The image path previously had only the SDK's max_retries=2 and no loop of
    # its own. Image endpoints carry far lower per-minute limits than text ones,
    # so a fan-out of concurrent generations exhausts the window and all of them
    # burn both attempts inside it. Every one that ran out then fell back to
    # DIAGRAM_FALLBACK_ORIGINAL — which embeds the ORIGINAL source artwork in the
    # deck. A rate limit is transient by definition; treating it as a permanent
    # failure is what turned throttling into un-enhanced third-party images
    # shipping to the reader.
    MAX_TRANSIENT_RETRIES = 8
    DEFAULT_RETRY_SLEEP_SECONDS = 8.0
    MAX_RETRY_SLEEP_SECONDS = 60.0

    # 408 request timeout, 409 conflict, 429 rate limit, 5xx capacity. Matches the
    # set the other two providers retry on.
    _TRANSIENT_STATUS_CODES = frozenset({408, 409, 429, 500, 502, 503, 504, 529})

    # Each generated image is billed at roughly this many credits. The credit
    # system only METERS TOKENS (CreditMeter) and converts them to credits via
    # the admin-configured ENHANCE_IMAGES rule -- the image API's own token usage
    # is tiny and would massively under-bill a generated image. So after each
    # image we record the reference-model output tokens that the rule prices at
    # CREDITS_PER_IMAGE.
    #
    # REFERENCE_OUTPUT_TOKENS_PER_CREDIT is that rule's OUTPUT_TOKENS rate -- its
    # divisor divided by its credits coefficient (i.e. how many reference-model
    # output tokens cost one credit). It is the SINGLE knob to retune if the
    # deployed ENHANCE_IMAGES rate changes; with it set correctly each image
    # costs about CREDITS_PER_IMAGE credits.
    CREDITS_PER_IMAGE = 0.25
    REFERENCE_OUTPUT_TOKENS_PER_CREDIT = 100000

    def __init__(self):
        self.__gemini_caller = AutomationCaller(GoogleEnterpriseAiProvider())
        self.__openai_client: AsyncOpenAI | None = None

        # Why each fallback happened, counted per reason.
        #
        # A fallback embeds the ORIGINAL source artwork, which is the exact
        # outcome this workflow exists to prevent — so it is a real defect even
        # though it is not a task failure. Until now it was also invisible: three
        # of the six paths that end in a fallback returned None with no output at
        # all, and the two that did print named only the STEP ("Gemini
        # description failed"), never the cause. A run could therefore ship
        # un-enhanced artwork with a clean task status and an empty log.
        self.__fallback_reason_counts: dict = {}
        self.__enhanced_count = 0

    def __record_fallback(self, reason: str) -> None:
        """
        Notes one fallback and prints it immediately. Printed per occurrence
        rather than only in the summary because the interleaving with other
        workers' output is what ties a failure to the image that caused it.
        """
        self.__fallback_reason_counts[reason] = self.__fallback_reason_counts.get(reason, 0) + 1
        print(f"[DiagramImageEnhancer] FALLBACK TO ORIGINAL — {reason}")

    @staticmethod
    def __describe_exception(caught_exception: Exception) -> str:
        """
        Type plus message, with the HTTP status and provider error code when the
        SDK exposes them. The distinction that matters here is rate limit vs
        content refusal vs timeout, and the bare str() of an SDK error often
        omits it — which is what made the earlier prints undiagnosable.
        """
        parts = [type(caught_exception).__name__]

        status_code = getattr(caught_exception, "status_code", None)
        if status_code is not None:
            parts.append(f"status={status_code}")

        error_payload = getattr(caught_exception, "code", None)
        if error_payload:
            parts.append(f"code={error_payload}")

        parts.append(str(caught_exception)[:300])
        return " | ".join(parts)

    async def enhance(self, image_bytes: bytes) -> dict:
        # Describe the figure (Gemini reads the image into prose) then regenerate
        # it as a fresh image (GPT-Image draws from that prose). The source image
        # is never sent to the image model, so the output is an original
        # re-expression of the figure's facts, not a copy.
        description = await self.__describe_for_generation(image_bytes)
        if not description:
            # The specific reason was already recorded by the callee; this only
            # marks which of the two stages the run stopped at.
            return {"kind": "DIAGRAM_FALLBACK_ORIGINAL"}

        generated_image_bytes = await self.__generate_image(description)
        if generated_image_bytes is None:
            return {"kind": "DIAGRAM_FALLBACK_ORIGINAL"}

        self.__enhanced_count += 1
        DiagramImageEnhancer.__record_image_credits()

        return {
            "kind": "DIAGRAM_IMAGE_PNG",
            "image_bytes": generated_image_bytes,
            "renderer": "gemini-gpt-image",
        }

    async def close(self):
        """
        Releases the underlying HTTP clients (OpenAI + Gemini) so the owning
        EnhanceImages task can shut down without leaking sockets or stalling
        interpreter teardown -- the root cause of the enhance subprocess hanging
        after its task was already marked COMPLETED. Idempotent and
        error-swallowing: a close fault must never fail the task.
        """
        # Summary first — close() is the one point that runs exactly once per
        # task, so it is where a reader can see the whole picture without
        # scrolling through interleaved per-image lines.
        fallback_total = sum(self.__fallback_reason_counts.values())
        print(
            f"[DiagramImageEnhancer] SUMMARY — enhanced {self.__enhanced_count}, "
            f"fell back to original {fallback_total}."
        )
        for reason, count in sorted(self.__fallback_reason_counts.items(), key=lambda item: -item[1]):
            print(f"[DiagramImageEnhancer] SUMMARY   {count} x {reason}")

        if self.__openai_client is not None:
            try:
                await self.__openai_client.close()
            except Exception as openai_close_error:
                print(f"[DiagramImageEnhancer] OpenAI client close failed (continuing): {openai_close_error}")
            self.__openai_client = None

        try:
            await self.__gemini_caller.aclose()
        except Exception as gemini_close_error:
            print(f"[DiagramImageEnhancer] Gemini caller close failed (continuing): {gemini_close_error}")

    @staticmethod
    def __record_image_credits() -> None:
        """
        Bills one generated image at ~CREDITS_PER_IMAGE credits by recording the
        equivalent reference-model output tokens into the process-global meter,
        which the ENHANCE_IMAGES rule then charges at task settle. Recorded
        against the reference model (weight 1.0) so the token count maps 1:1 to
        the rule's OUTPUT_TOKENS rate.
        """
        billing_output_tokens = round(
            DiagramImageEnhancer.CREDITS_PER_IMAGE
            * DiagramImageEnhancer.REFERENCE_OUTPUT_TOKENS_PER_CREDIT
        )
        CreditMeter.record(0, billing_output_tokens, ModelPricing.REFERENCE_MODEL)

    async def __describe_for_generation(self, image_bytes: bytes) -> str | None:
        """Gemini reads all of the figure's facts from the image into prose."""
        request = AutomationRequest(
            DiagramImageEnhancer.GEMINI_DESCRIBE_MODEL_NAME,
            [
                AutomationContent(AutomationContentTypes.SYSTEM, PromptPool.DIAGRAM_ENHANCER_DESCRIBE_SYSTEM),
                AutomationContent(AutomationContentTypes.IMAGE, image_bytes),
                AutomationContent(
                    AutomationContentTypes.TEXT,
                    PromptPool.DIAGRAM_ENHANCER_DESCRIBE_USER,
                    # The description must come back as plain prose. Without this,
                    # GoogleEnterpriseAiProvider defaults the response mime type to
                    # application/json, which fights the "write prose, not JSON"
                    # instruction in the prompt.
                    metadata={"response_as_text": True},
                ),
            ],
        )

        try:
            response = await self.__gemini_caller.call(request, None)
        except Exception as call_error:
            self.__record_fallback(f"describe: Gemini call raised — {DiagramImageEnhancer.__describe_exception(call_error)}")
            return None

        if response is None:
            self.__record_fallback("describe: Gemini returned no response object (provider returned None)")
            return None

        try:
            description = response.get_output(0).get_data()
        except (AttributeError, IndexError) as output_error:
            self.__record_fallback(f"describe: Gemini response carried no output block — {type(output_error).__name__}")
            return None

        if not isinstance(description, str) or not description.strip():
            self.__record_fallback(
                f"describe: Gemini output was not usable prose (type={type(description).__name__}, "
                f"length={len(description) if isinstance(description, str) else 'n/a'})"
            )
            return None

        return description.strip()

    async def __generate_image(self, description: str) -> bytes | None:
        """GPT-Image generates a new PNG from the description text. The source image is never passed."""
        openai_client = self.__get_openai_client()
        if openai_client is None:
            self.__record_fallback("generate: no OpenAI client (OPENAI_API_KEY unset or client construction failed)")
            return None

        generation_prompt = description + "\n\n" + PromptPool.DIAGRAM_ENHANCER_GPT_SUFFIX

        response = await self.__generate_with_transient_retry(openai_client, generation_prompt)
        if response is None:
            return None

        image_base64 = response.data[0].b64_json if response.data else None
        if not image_base64:
            self.__record_fallback("generate: gpt-image-2 returned an empty data array (no image produced)")
            return None

        try:
            return base64.b64decode(image_base64)
        except Exception as decode_error:
            self.__record_fallback(f"generate: base64 decode of the returned image failed — {type(decode_error).__name__}")
            return None

    async def __generate_with_transient_retry(self, openai_client: AsyncOpenAI, generation_prompt: str):
        """
        One image generation, retried through transient failures. Same two-layer
        shape the other providers use: the SDK retries within an attempt, this
        loop rides out the per-minute window above it.

        Returns the response, or None once the failure is permanent or the
        retries are spent — at which point the caller falls back and the reason
        has already been recorded.
        """
        attempt_index = 0

        while True:
            try:
                return await openai_client.images.generate(
                    model=DiagramImageEnhancer.GPT_IMAGE_MODEL_NAME,
                    prompt=generation_prompt,
                    size=DiagramImageEnhancer.GPT_IMAGE_SIZE,
                    quality=DiagramImageEnhancer.GPT_IMAGE_QUALITY,
                    n=1,
                )
            except Exception as api_error:
                if not DiagramImageEnhancer.__is_transient_error(api_error):
                    # A content refusal or a malformed request will fail the same
                    # way every time; retrying only delays the fallback.
                    self.__record_fallback(
                        f"generate: gpt-image-2 call raised — {DiagramImageEnhancer.__describe_exception(api_error)}"
                    )
                    return None

                if attempt_index >= DiagramImageEnhancer.MAX_TRANSIENT_RETRIES:
                    self.__record_fallback(
                        f"generate: gpt-image-2 still failing after {attempt_index} retries — "
                        f"{DiagramImageEnhancer.__describe_exception(api_error)}"
                    )
                    return None

                sleep_seconds = DiagramImageEnhancer.__resolve_retry_delay_seconds(api_error, attempt_index)
                print(
                    f"[DiagramImageEnhancer] {DiagramImageEnhancer.__describe_exception(api_error)} "
                    f"(attempt {attempt_index + 1}/{DiagramImageEnhancer.MAX_TRANSIENT_RETRIES}). "
                    f"Sleeping {sleep_seconds:.1f}s then retrying."
                )
                await ProviderHealthSignal.mark_slowdown("gpt-image rate limit / capacity")
                await asyncio.sleep(sleep_seconds)
                attempt_index += 1

    @staticmethod
    def __is_transient_error(api_error: Exception) -> bool:
        # A connection error never reached the server, so replaying it is safe.
        if isinstance(api_error, openai.APIConnectionError):
            return True

        status_code = getattr(api_error, "status_code", None)
        return status_code in DiagramImageEnhancer._TRANSIENT_STATUS_CODES

    @staticmethod
    def __resolve_retry_delay_seconds(api_error: Exception, attempt_index: int) -> float:
        seconds = DiagramImageEnhancer.__extract_retry_after_seconds(api_error)
        if seconds is None:
            # Exponential backoff anchored at DEFAULT_RETRY_SLEEP_SECONDS. Image
            # limits refill per minute, so a few rounds clear the window.
            seconds = DiagramImageEnhancer.DEFAULT_RETRY_SLEEP_SECONDS * (2 ** attempt_index)
        return min(max(seconds, 1.0), DiagramImageEnhancer.MAX_RETRY_SLEEP_SECONDS)

    @staticmethod
    def __extract_retry_after_seconds(api_error: Exception) -> float | None:
        """
        Reads the server-supplied Retry-After off the failed response. None when
        absent or unparseable, in which case the caller uses exponential backoff.
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

    def __get_openai_client(self) -> AsyncOpenAI | None:
        if self.__openai_client is not None:
            return self.__openai_client
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            print("[DiagramImageEnhancer] OPENAI_API_KEY not set -- image generation unavailable.")
            return None
        self.__openai_client = AsyncOpenAI(
            api_key=api_key,
            timeout=DiagramImageEnhancer.OPENAI_REQUEST_TIMEOUT_SECONDS,
            max_retries=DiagramImageEnhancer.OPENAI_MAX_RETRIES,
        )
        return self.__openai_client
