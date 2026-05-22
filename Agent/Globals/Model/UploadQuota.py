from datetime import datetime


class UploadQuota:
    def __init__(self, user_id: str = None, window_start: datetime = datetime.now(), file_count: int = 0, total_bytes: int = 0) -> None:
        self.set_user_id(user_id)
        self.set_window_start(window_start)
        self.set_file_count(file_count)
        self.set_total_bytes(total_bytes)

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

    def get_window_start(self) -> datetime:
        return self.__window_start

    def set_window_start(self, value: datetime) -> None:
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
        self.__window_start = value

    def get_file_count(self) -> int:
        return self.__file_count

    def set_file_count(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__file_count = value

    def get_total_bytes(self) -> int:
        return self.__total_bytes

    def set_total_bytes(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__total_bytes = value

    def to_json(self) -> dict:
        return {
            'userId': self.get_user_id(),
            'windowStart': self.get_window_start().isoformat() if self.get_window_start() is not None else None,
            'fileCount': self.get_file_count(),
            'totalBytes': self.get_total_bytes(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'UploadQuota':
        instance = cls(
            user_id=data.get('userId'),
            window_start=datetime.fromisoformat(data.get('windowStart')) if data.get('windowStart') is not None else None,
            file_count=data.get('fileCount'),
            total_bytes=data.get('totalBytes')
        )
        return instance
