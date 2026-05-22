import uuid
from datetime import datetime
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.TaskStatus import TaskStatus


class TaskHistoryRecord:
    def __init__(self, user_id: str = None, type: TaskTypes = TaskTypes(0), status: TaskStatus = TaskStatus(0), completion: float = 0, start_date: datetime = datetime.now(), completed_at: datetime = datetime.now(), duration_millis: int = 0, payload_summary: str = '', parent_task_id: str = '', additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_type(type)
        self.set_status(status)
        self.set_completion(completion)
        self.set_start_date(start_date)
        self.set_completed_at(completed_at)
        self.set_duration_millis(duration_millis)
        self.set_payload_summary(payload_summary)
        self.set_parent_task_id(parent_task_id)
        self.set_additional_data(additional_data)

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

    def get_status(self) -> TaskStatus:
        return self.__status

    def set_status(self, value: TaskStatus) -> None:
        if value is not None:
            valid_values = list(TaskStatus)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_completion(self) -> float:
        return self.__completion

    def set_completion(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 0
        self.__completion = value

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

    def get_completed_at(self) -> datetime:
        return self.__completed_at

    def set_completed_at(self, value: datetime) -> None:
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
        self.__completed_at = value

    def get_duration_millis(self) -> int:
        return self.__duration_millis

    def set_duration_millis(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__duration_millis = value

    def get_payload_summary(self) -> str:
        return self.__payload_summary

    def set_payload_summary(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 512:
                value = value[:512]
        self.__payload_summary = value

    def get_parent_task_id(self) -> str:
        return self.__parent_task_id

    def set_parent_task_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__parent_task_id = value

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
            'type': int(self.get_type().value) if self.get_type() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'completion': self.get_completion(),
            'startDate': self.get_start_date().isoformat() if self.get_start_date() is not None else None,
            'completedAt': self.get_completed_at().isoformat() if self.get_completed_at() is not None else None,
            'durationMillis': self.get_duration_millis(),
            'payloadSummary': self.get_payload_summary(),
            'parentTaskId': self.get_parent_task_id(),
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'TaskHistoryRecord':
        instance = cls(
            user_id=data.get('userId'),
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            status=TaskStatus(data.get('status')) if data.get('status') is not None else None,
            completion=data.get('completion'),
            start_date=datetime.fromisoformat(data.get('startDate')) if data.get('startDate') is not None else None,
            completed_at=datetime.fromisoformat(data.get('completedAt')) if data.get('completedAt') is not None else None,
            duration_millis=data.get('durationMillis'),
            payload_summary=data.get('payloadSummary'),
            parent_task_id=data.get('parentTaskId'),
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
