import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.MemberAttributeValueTypes import MemberAttributeValueTypes
from Globals.Enumerations.MemberColumnRenamePhases import MemberColumnRenamePhases


class OrganizationMemberColumn:
    def __init__(self, organization_id: str = None, key: str = None, label: str = None, value_type: MemberAttributeValueTypes = MemberAttributeValueTypes(0), aliases: List[str] = [], display_order: int = 0, rename_phase: MemberColumnRenamePhases = MemberColumnRenamePhases(0), pending_rename_to_key: str = '', created_at: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_key(key)
        self.set_label(label)
        self.set_value_type(value_type)
        self.set_aliases(aliases)
        self.set_display_order(display_order)
        self.set_rename_phase(rename_phase)
        self.set_pending_rename_to_key(pending_rename_to_key)
        self.set_created_at(created_at)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_key(self) -> str:
        return self.__key

    def set_key(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 64:
                value = value[:64]
            if value is not None and len(value) < 1:
                value = None
        self.__key = value

    def get_label(self) -> str:
        return self.__label

    def set_label(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 128:
                value = value[:128]
            if value is not None and len(value) < 1:
                value = None
        self.__label = value

    def get_value_type(self) -> MemberAttributeValueTypes:
        return self.__value_type

    def set_value_type(self, value: MemberAttributeValueTypes) -> None:
        if value is not None:
            valid_values = list(MemberAttributeValueTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__value_type = value

    def get_aliases(self) -> List[str]:
        return self.__aliases

    def set_aliases(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__aliases = value

    def get_display_order(self) -> int:
        return self.__display_order

    def set_display_order(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__display_order = value

    def get_rename_phase(self) -> MemberColumnRenamePhases:
        return self.__rename_phase

    def set_rename_phase(self, value: MemberColumnRenamePhases) -> None:
        if value is not None:
            valid_values = list(MemberColumnRenamePhases)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__rename_phase = value

    def get_pending_rename_to_key(self) -> str:
        return self.__pending_rename_to_key

    def set_pending_rename_to_key(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__pending_rename_to_key = value

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
            'key': self.get_key(),
            'label': self.get_label(),
            'valueType': int(self.get_value_type().value) if self.get_value_type() is not None else None,
            'aliases': self.get_aliases(),
            'displayOrder': self.get_display_order(),
            'renamePhase': int(self.get_rename_phase().value) if self.get_rename_phase() is not None else None,
            'pendingRenameToKey': self.get_pending_rename_to_key(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationMemberColumn':
        instance = cls(
            organization_id=data.get('organizationId'),
            key=data.get('key'),
            label=data.get('label'),
            value_type=MemberAttributeValueTypes(data.get('valueType')) if data.get('valueType') is not None else None,
            aliases=data.get('aliases'),
            display_order=data.get('displayOrder'),
            rename_phase=MemberColumnRenamePhases(data.get('renamePhase')) if data.get('renamePhase') is not None else None,
            pending_rename_to_key=data.get('pendingRenameToKey'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
