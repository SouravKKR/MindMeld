import uuid
from datetime import datetime


class ReleaseNote:
    def __init__(self, version: str = '', version_sort_key: int = 0, title: str = None, content_html: str = '', release_date: datetime = datetime.now(), created_at: datetime = datetime.now(), updated_at: datetime = datetime.now(), created_by: str = '', test: bool = False) -> None:
        self.__id = str(uuid.uuid4())
        self.set_version(version)
        self.set_version_sort_key(version_sort_key)
        self.set_title(title)
        self.set_content_html(content_html)
        self.set_release_date(release_date)
        self.set_created_at(created_at)
        self.set_updated_at(updated_at)
        self.set_created_by(created_by)
        self.set_test(test)

    def get_id(self) -> str:
        return self.__id

    def get_version(self) -> str:
        return self.__version

    def set_version(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 32:
                value = value[:32]
        self.__version = value

    def get_version_sort_key(self) -> int:
        return self.__version_sort_key

    def set_version_sort_key(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__version_sort_key = value

    def get_title(self) -> str:
        return self.__title

    def set_title(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__title = value

    def get_content_html(self) -> str:
        return self.__content_html

    def set_content_html(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 200000:
                value = value[:200000]
        self.__content_html = value

    def get_release_date(self) -> datetime:
        return self.__release_date

    def set_release_date(self, value: datetime) -> None:
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
        self.__release_date = value

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

    def get_updated_at(self) -> datetime:
        return self.__updated_at

    def set_updated_at(self, value: datetime) -> None:
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
        self.__updated_at = value

    def get_created_by(self) -> str:
        return self.__created_by

    def set_created_by(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__created_by = value

    def get_test(self) -> bool:
        return self.__test

    def set_test(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__test = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'version': self.get_version(),
            'versionSortKey': self.get_version_sort_key(),
            'title': self.get_title(),
            'contentHtml': self.get_content_html(),
            'releaseDate': self.get_release_date().isoformat() if self.get_release_date() is not None else None,
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'updatedAt': self.get_updated_at().isoformat() if self.get_updated_at() is not None else None,
            'createdBy': self.get_created_by(),
            'test': self.get_test(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'ReleaseNote':
        instance = cls(
            version=data.get('version'),
            version_sort_key=data.get('versionSortKey'),
            title=data.get('title'),
            content_html=data.get('contentHtml'),
            release_date=datetime.fromisoformat(data.get('releaseDate')) if data.get('releaseDate') is not None else None,
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            updated_at=datetime.fromisoformat(data.get('updatedAt')) if data.get('updatedAt') is not None else None,
            created_by=data.get('createdBy'),
            test=data.get('test')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
