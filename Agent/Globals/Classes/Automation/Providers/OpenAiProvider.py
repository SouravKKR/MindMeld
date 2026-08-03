import os
import base64

from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from Globals.Classes.Automation.AutomationProvider import AutomationProvider
from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Classes.Automation.AutomationRequest import AutomationRequest
from Globals.Classes.Automation.AutomationContent import AutomationContent
from openai import AsyncOpenAI


class OpenAiProvider(AutomationProvider):
    """
    OpenAI chat-completions provider.

    Data posture (asserted here rather than assumed). Requests carry user-
    uploaded coursework, so the retention posture matters and must be visible at
    the point it is relied upon:

      - `store=False` is set on every call, so prompts and completions are not
        persisted to the account for model-improvement or playground retrieval.
        The OpenAI API does not train on business-tier API data by default; this
        flag makes the intent explicit and survives a default changing.
      - Zero Data Retention, if required, is an ACCOUNT-level setting granted by
        OpenAI — it cannot be enabled from client code. Confirm it is active on
        the account backing OPENAI_API_KEY before routing production traffic
        here. Without it, OpenAI retains request data for up to 30 days for
        abuse monitoring.
      - This provider is not on the live generation path today (ModelPool routes
        to Vertex). Re-verify the account posture before that changes.
    """

    # Suppresses server-side persistence of prompts and completions.
    STORE_COMPLETIONS = False

    def __init__(self):
        self.__client: AsyncOpenAI = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    async def execute(self, request: AutomationRequest) -> AutomationResponse:
        text_messages = []
        image_inputs = []

        # ── 1. Collect ALL inputs first, THEN call the API ─────────────────────
        for content in request.get_inputs():
            content_type = content.get_content_type()
            data = content.get_data()

            match content_type:
                case AutomationContentTypes.SYSTEM:
                    text_messages.append({"role": "system", "content": data})

                case AutomationContentTypes.TEXT:
                    text_messages.append({"role": "user", "content": data})

                case AutomationContentTypes.IMAGE:
                    image_inputs.append(data)

        # ── 2. Build the request payload ───────────────────────────────────────
        if len(image_inputs) > 0:
            multimodal_content = []

            for message in text_messages:
                multimodal_content.append({"type": "text", "text": message["content"]})

            # TODO: encode and append image_inputs here
            # for image in image_inputs:
            #     multimodal_content.append({ "type": "image_url", "image_url": { "url": ... } })

            messages = [{"role": "user", "content": multimodal_content}]

        else:
            messages = text_messages

        # ── 3. Call the API once, after all inputs are collected ───────────────
        response = await self.__client.chat.completions.create(
            model=request.get_model(),
            messages=messages,
            store=OpenAiProvider.STORE_COMPLETIONS,
        )

        outputs = []
        for choice in response.choices:
            outputs.append(AutomationContent(AutomationContentTypes.TEXT, choice.message.content, None))

        return AutomationResponse(outputs)