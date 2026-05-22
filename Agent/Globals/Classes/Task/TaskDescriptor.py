import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.TaskStatus import TaskStatus
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets


class TaskDescriptor:
    def __init__(self, user_id: str = '', type: TaskTypes = TaskTypes(0), start_date: datetime = datetime.now(), expiration_date: datetime = datetime.now(), status: TaskStatus = TaskStatus(0), parent_task_id: str = '', next_task_ids: List[str] = [], completion: float = 0, payload: dict = {}, execution_target: TaskExecutionTargets = TaskExecutionTargets(0)) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_type(type)
        self.set_start_date(start_date)
        self.set_expiration_date(expiration_date)
        self.set_status(status)
        self.set_parent_task_id(parent_task_id)
        self.set_next_task_ids(next_task_ids)
        self.set_completion(completion)
        self.set_payload(payload)
        self.set_execution_target(execution_target)

    def get_id(self) -> str:
        return self.__id

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

    def get_type(self) -> TaskTypes:
        return self.__type

    def set_type(self, value: TaskTypes) -> None:
        if value is not None:
            valid_values = list(TaskTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__type = value

    def get_start_date(self) -> datetime:
        return self.__start_date

    def set_start_date(self, value: datetime) -> None:
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
        self.__start_date = value

    def get_expiration_date(self) -> datetime:
        return self.__expiration_date

    def set_expiration_date(self, value: datetime) -> None:
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
        self.__expiration_date = value

    def get_status(self) -> TaskStatus:
        return self.__status

    def set_status(self, value: TaskStatus) -> None:
        if value is not None:
            valid_values = list(TaskStatus)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_parent_task_id(self) -> str:
        return self.__parent_task_id

    def set_parent_task_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__parent_task_id = value

    def get_next_task_ids(self) -> List[str]:
        return self.__next_task_ids

    def set_next_task_ids(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__next_task_ids = value

    def get_completion(self) -> float:
        return self.__completion

    def set_completion(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 0
        self.__completion = value

    def get_payload(self) -> dict:
        return self.__payload

    def set_payload(self, value: dict) -> None:
        self.__payload = value

    def get_execution_target(self) -> TaskExecutionTargets:
        return self.__execution_target

    def set_execution_target(self, value: TaskExecutionTargets) -> None:
        if value is not None:
            valid_values = list(TaskExecutionTargets)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__execution_target = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'userId': self.get_user_id(),
            'type': int(self.get_type().value) if self.get_type() is not None else None,
            'startDate': self.get_start_date().isoformat() if self.get_start_date() is not None else None,
            'expirationDate': self.get_expiration_date().isoformat() if self.get_expiration_date() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'parentTaskId': self.get_parent_task_id(),
            'nextTaskIds': self.get_next_task_ids(),
            'completion': self.get_completion(),
            'payload': self.get_payload(),
            'executionTarget': int(self.get_execution_target().value) if self.get_execution_target() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'TaskDescriptor':
        instance = cls(
            user_id=data.get('userId'),
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            start_date=datetime.fromisoformat(data.get('startDate')) if data.get('startDate') is not None else None,
            expiration_date=datetime.fromisoformat(data.get('expirationDate')) if data.get('expirationDate') is not None else None,
            status=TaskStatus(data.get('status')) if data.get('status') is not None else None,
            parent_task_id=data.get('parentTaskId'),
            next_task_ids=data.get('nextTaskIds'),
            completion=data.get('completion'),
            payload=data.get('payload'),
            execution_target=TaskExecutionTargets(data.get('executionTarget')) if data.get('executionTarget') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
