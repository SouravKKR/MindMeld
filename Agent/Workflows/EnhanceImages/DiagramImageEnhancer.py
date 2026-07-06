import base64
import os

from openai import AsyncOpenAI

from Globals.Classes.Automation.AutomationCaller import AutomationCaller
from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.Pools.PromptPool import PromptPool
from Globals.Classes.Automation.Providers.GoogleEnterpriseAiProvider import GoogleEnterpriseAiProvider
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

    async def enhance(self, image_bytes: bytes) -> dict:
        # Describe the figure (Gemini reads the image into prose) then regenerate
        # it as a fresh image (GPT-Image draws from that prose). The source image
        # is never sent to the image model, so the output is an original
        # re-expression of the figure's facts, not a copy.
        description = await self.__describe_for_generation(image_bytes)
        if not description:
            print("[DiagramImageEnhancer] Gemini description failed.")
            return {"kind": "DIAGRAM_FALLBACK_ORIGINAL"}

        generated_image_bytes = await self.__generate_image(description)
        if generated_image_bytes is None:
            print("[DiagramImageEnhancer] GPT-Image generation failed.")
            return {"kind": "DIAGRAM_FALLBACK_ORIGINAL"}

        DiagramImageEnhancer.__record_image_credits()

        return {
            "kind": "DIAGRAM_IMAGE_PNG",
            "image_bytes": generated_image_bytes,
            "renderer": "gemini-gpt-image",
        }

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
            print(f"[DiagramImageEnhancer] Gemini describe call failed ({call_error}).")
            return None

        if response is None:
            return None

        description = response.get_output(0).get_data()
        if not isinstance(description, str) or not description.strip():
            return None
        return description.strip()

    async def __generate_image(self, description: str) -> bytes | None:
        """GPT-Image generates a new PNG from the description text. The source image is never passed."""
        openai_client = self.__get_openai_client()
        if openai_client is None:
            return None

        generation_prompt = description + "\n\n" + PromptPool.DIAGRAM_ENHANCER_GPT_SUFFIX

        try:
            response = await openai_client.images.generate(
                model=DiagramImageEnhancer.GPT_IMAGE_MODEL_NAME,
                prompt=generation_prompt,
                size=DiagramImageEnhancer.GPT_IMAGE_SIZE,
                quality=DiagramImageEnhancer.GPT_IMAGE_QUALITY,
                n=1,
            )
        except Exception as api_error:
            print(f"[DiagramImageEnhancer] GPT-Image generate call failed ({api_error}).")
            return None

        image_base64 = response.data[0].b64_json if response.data else None
        if not image_base64:
            print("[DiagramImageEnhancer] GPT-Image returned no image data.")
            return None

        try:
            return base64.b64decode(image_base64)
        except Exception as decode_error:
            print(f"[DiagramImageEnhancer] base64 decode failed ({decode_error}).")
            return None

    def __get_openai_client(self) -> AsyncOpenAI | None:
        if self.__openai_client is not None:
            return self.__openai_client
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            print("[DiagramImageEnhancer] OPENAI_API_KEY not set -- image generation unavailable.")
            return None
        self.__openai_client = AsyncOpenAI(api_key=api_key)
        return self.__openai_client
