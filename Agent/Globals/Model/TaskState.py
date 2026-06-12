import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.TaskTypes import TaskTypes


class TaskState:
    def __init__(self, user_id: str = '', task_type: TaskTypes = TaskTypes(0), route: str = '', payload: dict = {}, paused_reason: str = '', resource_paths: List[str] = [], created_at: datetime = datetime.now(), expires_at: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_task_type(task_type)
        self.set_route(route)
        self.set_payload(payload)
        self.set_paused_reason(paused_reason)
        self.set_resource_paths(resource_paths)
        self.set_created_at(created_at)
        self.set_expires_at(expires_at)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

    def get_task_type(self) -> TaskTypes:
        return self.__task_type

    def set_task_type(self, value: TaskTypes) -> None:
        if value is not None:
            valid_values = list(TaskTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__task_type = value

    def get_route(self) -> str:
        return self.__route

    def set_route(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__route = value

    def get_payload(self) -> dict:
        return self.__payload

    def set_payload(self, value: dict) -> None:
        self.__payload = value

    def get_paused_reason(self) -> str:
        return self.__paused_reason

    def set_paused_reason(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 128:
                value = value[:128]
        self.__paused_reason = value

    def get_resource_paths(self) -> List[str]:
        return self.__resource_paths

    def set_resource_paths(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__resource_paths = value

    def get_created_at(self) -> datetime:
        return self.__created_at

    def set_created_at(self, value: datetime) -> None:
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
        self.__created_at = value

    def get_expires_at(self) -> datetime:
        return self.__expires_at

    def set_expires_at(self, value: datetime) -> None:
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
        self.__expires_at = value

    def get_additional_data(self) -> dict:
        return self.__additional_data

    def set_additional_data(self, value: dict) -> None:
        self.__additional_data = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'userId': self.get_user_id(),
            'taskType': int(self.get_task_type().value) if self.get_task_type() is not None else None,
            'route': self.get_route(),
            'payload': self.get_payload(),
            'pausedReason': self.get_paused_reason(),
            'resourcePaths': self.get_resource_paths(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'expiresAt': self.get_expires_at().isoformat() if self.get_expires_at() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'TaskState':
        instance = cls(
            user_id=data.get('userId'),
            task_type=TaskTypes(data.get('taskType')) if data.get('taskType') is not None else None,
            route=data.get('route'),
            payload=data.get('payload'),
            paused_reason=data.get('pausedReason'),
            resource_paths=data.get('resourcePaths'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            expires_at=datetime.fromisoformat(data.get('expiresAt')) if data.get('expiresAt') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
