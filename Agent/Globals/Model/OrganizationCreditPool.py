import uuid
from datetime import datetime


class OrganizationCreditPool:
    def __init__(self, organization_id: str = None, balance: float = 0, lifetime_granted: float = 0, lifetime_distributed: float = 0, frozen: bool = False, updated_at: datetime = datetime.now()) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_balance(balance)
        self.set_lifetime_granted(lifetime_granted)
        self.set_lifetime_distributed(lifetime_distributed)
        self.set_frozen(frozen)
        self.set_updated_at(updated_at)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_balance(self) -> float:
        return self.__balance

    def set_balance(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__balance = value

    def get_lifetime_granted(self) -> float:
        return self.__lifetime_granted

    def set_lifetime_granted(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__lifetime_granted = value

    def get_lifetime_distributed(self) -> float:
        return self.__lifetime_distributed

    def set_lifetime_distributed(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__lifetime_distributed = value

    def get_frozen(self) -> bool:
        return self.__frozen

    def set_frozen(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__frozen = value

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

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'organizationId': self.get_organization_id(),
            'balance': self.get_balance(),
            'lifetimeGranted': self.get_lifetime_granted(),
            'lifetimeDistributed': self.get_lifetime_distributed(),
            'frozen': self.get_frozen(),
            'updatedAt': self.get_updated_at().isoformat() if self.get_updated_at() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationCreditPool':
        instance = cls(
            organization_id=data.get('organizationId'),
            balance=data.get('balance'),
            lifetime_granted=data.get('lifetimeGranted'),
            lifetime_distributed=data.get('lifetimeDistributed'),
            frozen=data.get('frozen'),
            updated_at=datetime.fromisoformat(data.get('updatedAt')) if data.get('updatedAt') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
