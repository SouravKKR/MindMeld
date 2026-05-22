from Globals.Classes.Task.AutoGeneration.GeneralGenerationSettings import GeneralGenerationSettings
from Workflows.Workflow import Workflow
class PrepareForGeneration(Workflow):
    def __init__(self, payload = {}):
        super().__init__(payload)
        self.__general_generation_settings: GeneralGenerationSettings = GeneralGenerationSettings.from_json(payload)

    async def run(self, args = {}):
        #TODO: Do any validation here
        print("Preparing for generation...")
        pass