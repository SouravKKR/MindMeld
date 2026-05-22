from datetime import datetime


class AdminEmailRecord:
    def __init__(self, email: str = None, added_by: str = '', added_at: datetime = datetime.now(), notes: str = '') -> None:
        self.set_email(email)
        self.set_added_by(added_by)
        self.set_added_at(added_at)
        self.set_notes(notes)

    def get_email(self) -> str:
        return self.__email

    def set_email(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 320:
                value = value[:320]
            if value is not None and len(value) < 3:
                value = None
        self.__email = value

    def get_added_by(self) -> str:
        return self.__added_by

    def set_added_by(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__added_by = value

    def get_added_at(self) -> datetime:
        return self.__added_at

    def set_added_at(self, value: datetime) -> None:
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
        self.__added_at = value

    def get_notes(self) -> str:
        return self.__notes

    def set_notes(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 1024:
                value = value[:1024]
        self.__notes = value

    def to_json(self) -> dict:
        return {
            'email': self.get_email(),
            'addedBy': self.get_added_by(),
            'addedAt': self.get_added_at().isoformat() if self.get_added_at() is not None else None,
            'notes': self.get_notes(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'AdminEmailRecord':
        instance = cls(
            email=data.get('email'),
            added_by=data.get('addedBy'),
            added_at=datetime.fromisoformat(data.get('addedAt')) if data.get('addedAt') is not None else None,
            notes=data.get('notes')
        )
        return instance
