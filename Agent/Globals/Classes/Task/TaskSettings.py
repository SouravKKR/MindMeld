import uuid
from Globals.Enumerations.TaskTypes import TaskTypes


class TaskSettings:
    def __init__(self, type: TaskTypes = None) -> None:
        self.__id = str(uuid.uuid4())
        self.set_type(type)

    def get_id(self) -> str:
        return self.__id

    def get_type(self) -> TaskTypes:
        return self.__type

    def set_type(self, value: TaskTypes) -> None:
        if value is not None:
            valid_values = list(TaskTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__type = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'type': int(self.get_type().value) if self.get_type() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'TaskSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
