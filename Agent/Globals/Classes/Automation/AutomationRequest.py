from Globals.Classes.Automation.AutomationContent import AutomationContent

class AutomationRequest:
    def __init__(self, model: str, inputs: list[AutomationContent]):
        self.__model = model
        self.__inputs = inputs
        pass

    def get_inputs(self) -> list[AutomationContent]:
        return self.__inputs
    
    def get_model(self) -> str:
        return self.__model
    
    def clear_inputs(self):
        self.__inputs = []

    def add_input(self, input: AutomationContent):
        self.__inputs.append(input)

    def add_inputs(self, inputs: list[AutomationContent]):
        self.__inputs.extend(inputs)

