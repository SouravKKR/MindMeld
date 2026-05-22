
class UserSetting:
    def __init__(self, key: str = '', value: dict = None, default_value: dict = None, flags: int = 0, additional_data: dict = {}) -> None:
        self.set_key(key)
        self.set_value(value)
        self.set_default_value(default_value)
        self.set_flags(flags)
        self.set_additional_data(additional_data)

    def get_key(self) -> str:
        return self.__key

    def set_key(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__key = value

    def get_value(self) -> dict:
        return self.__value

    def set_value(self, value: dict) -> None:
        self.__value = value

    def get_default_value(self) -> dict:
        return self.__default_value

    def set_default_value(self, value: dict) -> None:
        self.__default_value = value

    def get_flags(self) -> int:
        return self.__flags

    def set_flags(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
            except (ValueError, TypeError):
                value = 0
        self.__flags = value

    def get_additional_data(self) -> dict:
        return self.__additional_data

    def set_additional_data(self, value: dict) -> None:
        self.__additional_data = value

    def to_json(self) -> dict:
        return {
            'key': self.get_key(),
            'value': self.get_value(),
            'defaultValue': self.get_default_value(),
            'flags': self.get_flags(),
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'UserSetting':
        instance = cls(
            key=data.get('key'),
            value=data.get('value'),
            default_value=data.get('defaultValue'),
            flags=data.get('flags'),
            additional_data=data.get('additionalData')
        )
        return instance
