import uuid
from datetime import datetime


class OrganizationMember:
    def __init__(self, organization_id: str = None, email: str = None, user_id: str = '', added_by: str = '', added_at: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_email(email)
        self.set_user_id(user_id)
        self.set_added_by(added_by)
        self.set_added_at(added_at)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

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

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

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

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'organizationId': self.get_organization_id(),
            'email': self.get_email(),
            'userId': self.get_user_id(),
            'addedBy': self.get_added_by(),
            'addedAt': self.get_added_at().isoformat() if self.get_added_at() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationMember':
        instance = cls(
            organization_id=data.get('organizationId'),
            email=data.get('email'),
            user_id=data.get('userId'),
            added_by=data.get('addedBy'),
            added_at=datetime.fromisoformat(data.get('addedAt')) if data.get('addedAt') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
