import uuid
from datetime import datetime
from Globals.Enumerations.DeckLicenseStatuses import DeckLicenseStatuses


class DeckLicense:
    def __init__(self, user_id: str = None, deck_id: str = None, status: DeckLicenseStatuses = DeckLicenseStatuses(1), key_version: int = 1, wrapped_key_blob: str = '', issued_at: datetime = datetime.now(), rotated_at: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_deck_id(deck_id)
        self.set_status(status)
        self.set_key_version(key_version)
        self.set_wrapped_key_blob(wrapped_key_blob)
        self.set_issued_at(issued_at)
        self.set_rotated_at(rotated_at)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

    def get_deck_id(self) -> str:
        return self.__deck_id

    def set_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__deck_id = value

    def get_status(self) -> DeckLicenseStatuses:
        return self.__status

    def set_status(self, value: DeckLicenseStatuses) -> None:
        if value is not None:
            valid_values = list(DeckLicenseStatuses)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_key_version(self) -> int:
        return self.__key_version

    def set_key_version(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(1, value)
            except (ValueError, TypeError):
                value = 1
        self.__key_version = value

    def get_wrapped_key_blob(self) -> str:
        return self.__wrapped_key_blob

    def set_wrapped_key_blob(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__wrapped_key_blob = value

    def get_issued_at(self) -> datetime:
        return self.__issued_at

    def set_issued_at(self, value: datetime) -> None:
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
        self.__issued_at = value

    def get_rotated_at(self) -> datetime:
        return self.__rotated_at

    def set_rotated_at(self, value: datetime) -> None:
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
        self.__rotated_at = value

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
            'deckId': self.get_deck_id(),
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'keyVersion': self.get_key_version(),
            'wrappedKeyBlob': self.get_wrapped_key_blob(),
            'issuedAt': self.get_issued_at().isoformat() if self.get_issued_at() is not None else None,
            'rotatedAt': self.get_rotated_at().isoformat() if self.get_rotated_at() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'DeckLicense':
        instance = cls(
            user_id=data.get('userId'),
            deck_id=data.get('deckId'),
            status=DeckLicenseStatuses(data.get('status')) if data.get('status') is not None else None,
            key_version=data.get('keyVersion'),
            wrapped_key_blob=data.get('wrappedKeyBlob'),
            issued_at=datetime.fromisoformat(data.get('issuedAt')) if data.get('issuedAt') is not None else None,
            rotated_at=datetime.fromisoformat(data.get('rotatedAt')) if data.get('rotatedAt') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
