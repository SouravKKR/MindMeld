from Globals.Classes.Automation.AutomationContent import AutomationContent

class AutomationResponse:
    def __init__(self, outputs: list[AutomationContent], usage_metadata: dict = None, grounding_sources: list = None):
        self.__outputs = outputs
        # { "inputTokens": int, "outputTokens": int } when the provider
        # surfaced usage; None otherwise. Existing callers ignore it.
        self.__usage_metadata = usage_metadata
        # [{ "uri": str, "title": str }] read off the provider's own grounding
        # metadata when a web-search-enabled call actually consulted something.
        #
        # Deliberately NOT whatever the model claimed in its answer. A model
        # asked to "list the URLs you used" will happily produce plausible ones
        # it never opened, and these end up rendered into an audit document as
        # evidence of what a piece of sold content was checked against. A URL
        # the transport observed is a fact; a URL the model wrote is prose.
        #
        # Empty when the call was not grounded, and also empty on providers
        # that expose no equivalent — callers must present that as "not
        # recorded" rather than as "nothing was consulted".
        self.__grounding_sources = grounding_sources or []

    def get_outputs(self) -> list[AutomationContent]:
        return self.__outputs

    def get_output(self, index: int = 0) -> AutomationContent:
        return self.__outputs[index]

    def get_usage_metadata(self) -> dict:
        return self.__usage_metadata

    def get_grounding_sources(self) -> list:
        return self.__grounding_sources