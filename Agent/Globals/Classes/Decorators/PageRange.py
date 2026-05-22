
class PageRange:
    def __init__(self, start_page: int = 0, end_page: int = 0) -> None:
        self.set_start_page(start_page)
        self.set_end_page(end_page)

    def get_start_page(self) -> int:
        return self.__start_page

    def set_start_page(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__start_page = value

    def get_end_page(self) -> int:
        return self.__end_page

    def set_end_page(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__end_page = value

    def to_json(self) -> dict:
        return {
            'startPage': self.get_start_page(),
            'endPage': self.get_end_page(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PageRange':
        instance = cls(
            start_page=data.get('startPage'),
            end_page=data.get('endPage')
        )
        return instance
