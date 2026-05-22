from Globals.Enumerations.AutomationContentTypes import AutomationContentTypes
from typing import Any

class AutomationContent:
    def __init__(self, content_type: AutomationContentTypes, data: Any, metadata: dict | None = None):
        self.__content_type = content_type
        self.__data = data
        self.__metadata = metadata or {}

    def get_content_type(self) -> AutomationContentTypes:
        return self.__content_type
    
    def get_data(self) -> Any:
        return self.__data
    
    def get_metadata(self) -> dict:
        return self.__metadata
    
    def set_metadata(self, metadata: dict):
        self.__metadata = metadata

    def set_data(self, data: Any):
        self.__data = data

    def set_content_type(self, content_type: AutomationContentTypes):
        self.__content_type = content_type

    
    
