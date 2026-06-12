from Globals.Classes.Automation.AutomationContent import AutomationContent

class AutomationResponse:
    def __init__(self, outputs: list[AutomationContent], usage_metadata: dict = None):
        self.__outputs = outputs
        # { "inputTokens": int, "outputTokens": int } when the provider
        # surfaced usage; None otherwise. Existing callers ignore it.
        self.__usage_metadata = usage_metadata

    def get_outputs(self) -> list[AutomationContent]:
        return self.__outputs

    def get_output(self, index: int = 0) -> AutomationContent:
        return self.__outputs[index]

    def get_usage_metadata(self) -> dict:
        return self.__usage_metadata