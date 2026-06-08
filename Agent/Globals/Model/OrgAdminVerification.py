import uuid
from datetime import datetime


class OrgAdminVerification:
    def __init__(self, email: str = None, code_hash: str = '', attempts: int = 0, verification_token: str = '', created_at: datetime = datetime.now(), expiration_date: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_email(email)
        self.set_code_hash(code_hash)
        self.set_attempts(attempts)
        self.set_verification_token(verification_token)
        self.set_created_at(created_at)
        self.set_expiration_date(expiration_date)

    def get_id(self) -> str:
        return self.__id

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

    def get_code_hash(self) -> str:
        return self.__code_hash

    def set_code_hash(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__code_hash = value

    def get_attempts(self) -> int:
        return self.__attempts

    def set_attempts(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__attempts = value

    def get_verification_token(self) -> str:
        return self.__verification_token

    def set_verification_token(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__verification_token = value

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

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'email': self.get_email(),
            'codeHash': self.get_code_hash(),
            'attempts': self.get_attempts(),
            'verificationToken': self.get_verification_token(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'expirationDate': self.get_expiration_date().isoformat() if self.get_expiration_date() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrgAdminVerification':
        instance = cls(
            email=data.get('email'),
            code_hash=data.get('codeHash'),
            attempts=data.get('attempts'),
            verification_token=data.get('verificationToken'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            expiration_date=datetime.fromisoformat(data.get('expirationDate')) if data.get('expirationDate') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
