import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.TagMatchModes import TagMatchModes
from Globals.Enumerations.PlanFeatures import PlanFeatures


class OrganizationPermissionRule:
    def __init__(self, organization_id: str = None, name: str = None, tag_filter: List[str] = [], match_mode: TagMatchModes = TagMatchModes(0), allowed_features: List[PlanFeatures] = [], storage_grant_bytes: int = 0, created_at: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_name(name)
        self.set_tag_filter(tag_filter)
        self.set_match_mode(match_mode)
        self.set_allowed_features(allowed_features)
        self.set_storage_grant_bytes(storage_grant_bytes)
        self.set_created_at(created_at)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_name(self) -> str:
        return self.__name

    def set_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__name = value

    def get_tag_filter(self) -> List[str]:
        return self.__tag_filter

    def set_tag_filter(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__tag_filter = value

    def get_match_mode(self) -> TagMatchModes:
        return self.__match_mode

    def set_match_mode(self, value: TagMatchModes) -> None:
        if value is not None:
            valid_values = list(TagMatchModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__match_mode = value

    def get_allowed_features(self) -> List[PlanFeatures]:
        return self.__allowed_features

    def set_allowed_features(self, value: List[PlanFeatures]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__allowed_features = value

    def get_storage_grant_bytes(self) -> int:
        return self.__storage_grant_bytes

    def set_storage_grant_bytes(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__storage_grant_bytes = value

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

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'organizationId': self.get_organization_id(),
            'name': self.get_name(),
            'tagFilter': self.get_tag_filter(),
            'matchMode': int(self.get_match_mode().value) if self.get_match_mode() is not None else None,
            'allowedFeatures': [int(item.value) for item in self.get_allowed_features()] if self.get_allowed_features() is not None else None,
            'storageGrantBytes': self.get_storage_grant_bytes(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationPermissionRule':
        instance = cls(
            organization_id=data.get('organizationId'),
            name=data.get('name'),
            tag_filter=data.get('tagFilter'),
            match_mode=TagMatchModes(data.get('matchMode')) if data.get('matchMode') is not None else None,
            allowed_features=[PlanFeatures(v) for v in data.get('allowedFeatures')] if data.get('allowedFeatures') is not None else None,
            storage_grant_bytes=data.get('storageGrantBytes'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
