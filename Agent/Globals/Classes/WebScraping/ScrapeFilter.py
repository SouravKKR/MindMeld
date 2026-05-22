from Globals.Enumerations.ScrapeFilterTypes import ScrapeFilterTypes

class ScrapeFilter:
    def __init__(self, filter_type: ScrapeFilterTypes, value: str = ""):
        self.__filter_type = filter_type
        self.__value = value

    def get_filter_type(self) -> ScrapeFilterTypes:
        return self.__filter_type
    
    def get_value(self) -> str:
        return self.__value
    
    def is_value_empty(self) -> bool:
        return self.__value == ""
    
    def is_valid(self) -> bool:
        if self.is_value_empty():
            return False
        
        #Any other checks come here
        
        return True 
