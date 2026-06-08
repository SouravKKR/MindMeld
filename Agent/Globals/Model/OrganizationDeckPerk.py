import uuid
from datetime import datetime
from Globals.Enumerations.OrganizationDeckPerkTypes import OrganizationDeckPerkTypes


class OrganizationDeckPerk:
    def __init__(self, organization_id: str = None, deck_id: str = None, perk_type: OrganizationDeckPerkTypes = OrganizationDeckPerkTypes(0), perk_value: int = 0, duration_days: int = 0, created_at: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_deck_id(deck_id)
        self.set_perk_type(perk_type)
        self.set_perk_value(perk_value)
        self.set_duration_days(duration_days)
        self.set_created_at(created_at)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_deck_id(self) -> str:
        return self.__deck_id

    def set_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__deck_id = value

    def get_perk_type(self) -> OrganizationDeckPerkTypes:
        return self.__perk_type

    def set_perk_type(self, value: OrganizationDeckPerkTypes) -> None:
        if value is not None:
            valid_values = list(OrganizationDeckPerkTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__perk_type = value

    def get_perk_value(self) -> int:
        return self.__perk_value

    def set_perk_value(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__perk_value = value

    def get_duration_days(self) -> int:
        return self.__duration_days

    def set_duration_days(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__duration_days = value

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
            'deckId': self.get_deck_id(),
            'perkType': int(self.get_perk_type().value) if self.get_perk_type() is not None else None,
            'perkValue': self.get_perk_value(),
            'durationDays': self.get_duration_days(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationDeckPerk':
        instance = cls(
            organization_id=data.get('organizationId'),
            deck_id=data.get('deckId'),
            perk_type=OrganizationDeckPerkTypes(data.get('perkType')) if data.get('perkType') is not None else None,
            perk_value=data.get('perkValue'),
            duration_days=data.get('durationDays'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
