from typing import List
from Globals.Model.InformationSource import InformationSource
from Globals.Classes.Decorators.PageRange import PageRange


class ExtractableInformationSource:
    def __init__(self, information_source: InformationSource = None, page_ranges: List[PageRange] = []) -> None:
        self.set_information_source(information_source)
        self.set_page_ranges(page_ranges)

    def get_information_source(self) -> InformationSource:
        return self.__information_source

    def set_information_source(self, value: InformationSource) -> None:
        self.__information_source = value

    def get_page_ranges(self) -> List[PageRange]:
        return self.__page_ranges

    def set_page_ranges(self, value: List[PageRange]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__page_ranges = value

    def to_json(self) -> dict:
        return {
            'informationSource': self.get_information_source().to_json() if self.get_information_source() is not None else None,
            'pageRanges': [item.to_json() for item in self.get_page_ranges()] if self.get_page_ranges() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'ExtractableInformationSource':
        instance = cls(
            information_source=InformationSource.from_json(data.get('informationSource')) if data.get('informationSource') is not None else None,
            page_ranges=[PageRange.from_json(v) for v in data.get('pageRanges')] if data.get('pageRanges') is not None else None
        )
        return instance
