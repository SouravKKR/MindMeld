from Globals.Classes.Automation.AutomationContent import AutomationContent

class AutomationResponse:
    def __init__(self, outputs: list[AutomationContent]):
        self.__outputs = outputs

    def get_outputs(self) -> list[AutomationContent]:
        return self.__outputs
    
    def get_output(self, index: int = 0) -> AutomationContent:
        return self.__outputs[index]