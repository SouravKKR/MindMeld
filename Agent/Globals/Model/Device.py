import uuid
from datetime import datetime
from Globals.Enumerations.DevicePlatforms import DevicePlatforms


class Device:
    def __init__(self, user_id: str = None, device_name: str = '', platform: DevicePlatforms = DevicePlatforms(0), user_agent: str = '', created_at: datetime = datetime.now(), last_seen_date: datetime = datetime.now(), last_sync_date: datetime = datetime.now(), public_key_fingerprint: str = '', fingerprint_hash: str = '', additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_device_name(device_name)
        self.set_platform(platform)
        self.set_user_agent(user_agent)
        self.set_created_at(created_at)
        self.set_last_seen_date(last_seen_date)
        self.set_last_sync_date(last_sync_date)
        self.set_public_key_fingerprint(public_key_fingerprint)
        self.set_fingerprint_hash(fingerprint_hash)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__user_id = value

    def get_device_name(self) -> str:
        return self.__device_name

    def set_device_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__device_name = value

    def get_platform(self) -> DevicePlatforms:
        return self.__platform

    def set_platform(self, value: DevicePlatforms) -> None:
        if value is not None:
            valid_values = list(DevicePlatforms)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__platform = value

    def get_user_agent(self) -> str:
        return self.__user_agent

    def set_user_agent(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 1024:
                value = value[:1024]
        self.__user_agent = value

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

    def get_last_seen_date(self) -> datetime:
        return self.__last_seen_date

    def set_last_seen_date(self, value: datetime) -> None:
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
        self.__last_seen_date = value

    def get_last_sync_date(self) -> datetime:
        return self.__last_sync_date

    def set_last_sync_date(self, value: datetime) -> None:
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
        self.__last_sync_date = value

    def get_public_key_fingerprint(self) -> str:
        return self.__public_key_fingerprint

    def set_public_key_fingerprint(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__public_key_fingerprint = value

    def get_fingerprint_hash(self) -> str:
        return self.__fingerprint_hash

    def set_fingerprint_hash(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 128:
                value = value[:128]
        self.__fingerprint_hash = value

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
            'deviceName': self.get_device_name(),
            'platform': int(self.get_platform().value) if self.get_platform() is not None else None,
            'userAgent': self.get_user_agent(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'lastSeenDate': self.get_last_seen_date().isoformat() if self.get_last_seen_date() is not None else None,
            'lastSyncDate': self.get_last_sync_date().isoformat() if self.get_last_sync_date() is not None else None,
            'publicKeyFingerprint': self.get_public_key_fingerprint(),
            'fingerprintHash': self.get_fingerprint_hash(),
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'Device':
        instance = cls(
            user_id=data.get('userId'),
            device_name=data.get('deviceName'),
            platform=DevicePlatforms(data.get('platform')) if data.get('platform') is not None else None,
            user_agent=data.get('userAgent'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            last_seen_date=datetime.fromisoformat(data.get('lastSeenDate')) if data.get('lastSeenDate') is not None else None,
            last_sync_date=datetime.fromisoformat(data.get('lastSyncDate')) if data.get('lastSyncDate') is not None else None,
            public_key_fingerprint=data.get('publicKeyFingerprint'),
            fingerprint_hash=data.get('fingerprintHash'),
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
