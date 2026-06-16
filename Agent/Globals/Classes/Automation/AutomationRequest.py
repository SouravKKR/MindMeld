from Globals.Classes.Automation.AutomationContent import AutomationContent
from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes

class AutomationRequest:
    def __init__(self, model: str, inputs: list[AutomationContent]):
        self.__model = model
        self.__inputs = inputs
        pass

    def get_inputs(self) -> list[AutomationContent]:
        return self.__inputs

    def get_model(self) -> str:
        return self.__model

    def get_text_content(self) -> str:
        # Concatenates the textual inputs (system + user text) into one string.
        # Used as the chars/4 token-estimate fallback when a provider returns
        # no usage_metadata. Non-text inputs (images, audio, video) are skipped.
        text_parts = []
        for content in self.__inputs:
            content_type = content.get_content_type()
            if content_type in (AutomationContentTypes.TEXT, AutomationContentTypes.SYSTEM):
                data = content.get_data()
                if isinstance(data, str):
                    text_parts.append(data)
        return "\n".join(text_parts)

    def clear_inputs(self):
        self.__inputs = []

    def add_input(self, input: AutomationContent):
        self.__inputs.append(input)

    def add_inputs(self, inputs: list[AutomationContent]):
        self.__inputs.extend(inputs)

