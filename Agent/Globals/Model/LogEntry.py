import uuid
from datetime import datetime
from Globals.Enumerations.LogLevel import LogLevel
from Globals.Enumerations.LogCategory import LogCategory
from Globals.Enumerations.LogServiceOrigin import LogServiceOrigin


class LogEntry:
    def __init__(self, level: LogLevel = LogLevel(1), category: LogCategory = LogCategory(0), title: str = '', message: str = '', service: LogServiceOrigin = LogServiceOrigin(0), account_id: str = '', error_code: str = '', error_reason: str = '', additional_data: dict = {}, timestamp: datetime = datetime.now(), timestamp_iso_string: str = '', sequence: int = 0, environment: str = '') -> None:
        self.__id = str(uuid.uuid4())
        self.set_level(level)
        self.set_category(category)
        self.set_title(title)
        self.set_message(message)
        self.set_service(service)
        self.set_account_id(account_id)
        self.set_error_code(error_code)
        self.set_error_reason(error_reason)
        self.set_additional_data(additional_data)
        self.set_timestamp(timestamp)
        self.set_timestamp_iso_string(timestamp_iso_string)
        self.set_sequence(sequence)
        self.set_environment(environment)

    def get_id(self) -> str:
        return self.__id

    def get_level(self) -> LogLevel:
        return self.__level

    def set_level(self, value: LogLevel) -> None:
        if value is not None:
            valid_values = list(LogLevel)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__level = value

    def get_category(self) -> LogCategory:
        return self.__category

    def set_category(self, value: LogCategory) -> None:
        if value is not None:
            valid_values = list(LogCategory)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__category = value

    def get_title(self) -> str:
        return self.__title

    def set_title(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__title = value

    def get_message(self) -> str:
        return self.__message

    def set_message(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__message = value

    def get_service(self) -> LogServiceOrigin:
        return self.__service

    def set_service(self, value: LogServiceOrigin) -> None:
        if value is not None:
            valid_values = list(LogServiceOrigin)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__service = value

    def get_account_id(self) -> str:
        return self.__account_id

    def set_account_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__account_id = value

    def get_error_code(self) -> str:
        return self.__error_code

    def set_error_code(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__error_code = value

    def get_error_reason(self) -> str:
        return self.__error_reason

    def set_error_reason(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__error_reason = value

    def get_additional_data(self) -> dict:
        return self.__additional_data

    def set_additional_data(self, value: dict) -> None:
        self.__additional_data = value

    def get_timestamp(self) -> datetime:
        return self.__timestamp

    def set_timestamp(self, value: datetime) -> None:
        if value is not None:
            if isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    value = datetime.now()
            elif not isinstance(value, datetime):
                value = datetime.now()
        else:
            value = datetime.now()
        self.__timestamp = value

    def get_timestamp_iso_string(self) -> str:
        return self.__timestamp_iso_string

    def set_timestamp_iso_string(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__timestamp_iso_string = value

    def get_sequence(self) -> int:
        return self.__sequence

    def set_sequence(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__sequence = value

    def get_environment(self) -> str:
        return self.__environment

    def set_environment(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__environment = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'level': int(self.get_level().value) if self.get_level() is not None else None,
            'category': int(self.get_category().value) if self.get_category() is not None else None,
            'title': self.get_title(),
            'message': self.get_message(),
            'service': int(self.get_service().value) if self.get_service() is not None else None,
            'accountId': self.get_account_id(),
            'errorCode': self.get_error_code(),
            'errorReason': self.get_error_reason(),
            'additionalData': self.get_additional_data(),
            'timestamp': self.get_timestamp().isoformat() if self.get_timestamp() is not None else None,
            'timestampIsoString': self.get_timestamp_iso_string(),
            'sequence': self.get_sequence(),
            'environment': self.get_environment(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'LogEntry':
        instance = cls(
            level=LogLevel(data.get('level')) if data.get('level') is not None else None,
            category=LogCategory(data.get('category')) if data.get('category') is not None else None,
            title=data.get('title'),
            message=data.get('message'),
            service=LogServiceOrigin(data.get('service')) if data.get('service') is not None else None,
            account_id=data.get('accountId'),
            error_code=data.get('errorCode'),
            error_reason=data.get('errorReason'),
            additional_data=data.get('additionalData'),
            timestamp=datetime.fromisoformat(data.get('timestamp')) if data.get('timestamp') is not None else None,
            timestamp_iso_string=data.get('timestampIsoString'),
            sequence=data.get('sequence'),
            environment=data.get('environment')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
