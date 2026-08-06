import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.OrganizationStatus import OrganizationStatus
from Globals.Enumerations.PlanFeatures import PlanFeatures


class Organization:
    def __init__(self, name: str = None, admin_email: str = None, admin_user_id: str = '', status: OrganizationStatus = OrganizationStatus(0), currency: str = 'INR', creation_amount_minor: int = 0, max_members: int = 0, current_member_count: int = 0, creation_date: datetime = datetime.now(), activation_date: datetime = datetime.now(), term_ends_at: datetime = datetime.now(), max_storage_grant_bytes_per_member: int = 0, max_credits_per_member_per_month: float = 0, max_published_decks: int = 0, grantable_features: List[PlanFeatures] = [], additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_name(name)
        self.set_admin_email(admin_email)
        self.set_admin_user_id(admin_user_id)
        self.set_status(status)
        self.set_currency(currency)
        self.set_creation_amount_minor(creation_amount_minor)
        self.set_max_members(max_members)
        self.set_current_member_count(current_member_count)
        self.set_creation_date(creation_date)
        self.set_activation_date(activation_date)
        self.set_term_ends_at(term_ends_at)
        self.set_max_storage_grant_bytes_per_member(max_storage_grant_bytes_per_member)
        self.set_max_credits_per_member_per_month(max_credits_per_member_per_month)
        self.set_max_published_decks(max_published_decks)
        self.set_grantable_features(grantable_features)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

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

    def get_admin_email(self) -> str:
        return self.__admin_email

    def set_admin_email(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 320:
                value = value[:320]
            if value is not None and len(value) < 3:
                value = None
        self.__admin_email = value

    def get_admin_user_id(self) -> str:
        return self.__admin_user_id

    def set_admin_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__admin_user_id = value

    def get_status(self) -> OrganizationStatus:
        return self.__status

    def set_status(self, value: OrganizationStatus) -> None:
        if value is not None:
            valid_values = list(OrganizationStatus)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_currency(self) -> str:
        return self.__currency

    def set_currency(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 8:
                value = value[:8]
        self.__currency = value

    def get_creation_amount_minor(self) -> int:
        return self.__creation_amount_minor

    def set_creation_amount_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__creation_amount_minor = value

    def get_max_members(self) -> int:
        return self.__max_members

    def set_max_members(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__max_members = value

    def get_current_member_count(self) -> int:
        return self.__current_member_count

    def set_current_member_count(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__current_member_count = value

    def get_creation_date(self) -> datetime:
        return self.__creation_date

    def set_creation_date(self, value: datetime) -> None:
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
        self.__creation_date = value

    def get_activation_date(self) -> datetime:
        return self.__activation_date

    def set_activation_date(self, value: datetime) -> None:
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
        self.__activation_date = value

    def get_term_ends_at(self) -> datetime:
        return self.__term_ends_at

    def set_term_ends_at(self, value: datetime) -> None:
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
        self.__term_ends_at = value

    def get_max_storage_grant_bytes_per_member(self) -> int:
        return self.__max_storage_grant_bytes_per_member

    def set_max_storage_grant_bytes_per_member(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__max_storage_grant_bytes_per_member = value

    def get_max_credits_per_member_per_month(self) -> float:
        return self.__max_credits_per_member_per_month

    def set_max_credits_per_member_per_month(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__max_credits_per_member_per_month = value

    def get_max_published_decks(self) -> int:
        return self.__max_published_decks

    def set_max_published_decks(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__max_published_decks = value

    def get_grantable_features(self) -> List[PlanFeatures]:
        return self.__grantable_features

    def set_grantable_features(self, value: List[PlanFeatures]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__grantable_features = value

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
            'name': self.get_name(),
            'adminEmail': self.get_admin_email(),
            'adminUserId': self.get_admin_user_id(),
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'currency': self.get_currency(),
            'creationAmountMinor': self.get_creation_amount_minor(),
            'maxMembers': self.get_max_members(),
            'currentMemberCount': self.get_current_member_count(),
            'creationDate': self.get_creation_date().isoformat() if self.get_creation_date() is not None else None,
            'activationDate': self.get_activation_date().isoformat() if self.get_activation_date() is not None else None,
            'termEndsAt': self.get_term_ends_at().isoformat() if self.get_term_ends_at() is not None else None,
            'maxStorageGrantBytesPerMember': self.get_max_storage_grant_bytes_per_member(),
            'maxCreditsPerMemberPerMonth': self.get_max_credits_per_member_per_month(),
            'maxPublishedDecks': self.get_max_published_decks(),
            'grantableFeatures': [int(item.value) for item in self.get_grantable_features()] if self.get_grantable_features() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'Organization':
        instance = cls(
            name=data.get('name'),
            admin_email=data.get('adminEmail'),
            admin_user_id=data.get('adminUserId'),
            status=OrganizationStatus(data.get('status')) if data.get('status') is not None else None,
            currency=data.get('currency'),
            creation_amount_minor=data.get('creationAmountMinor'),
            max_members=data.get('maxMembers'),
            current_member_count=data.get('currentMemberCount'),
            creation_date=datetime.fromisoformat(data.get('creationDate')) if data.get('creationDate') is not None else None,
            activation_date=datetime.fromisoformat(data.get('activationDate')) if data.get('activationDate') is not None else None,
            term_ends_at=datetime.fromisoformat(data.get('termEndsAt')) if data.get('termEndsAt') is not None else None,
            max_storage_grant_bytes_per_member=data.get('maxStorageGrantBytesPerMember'),
            max_credits_per_member_per_month=data.get('maxCreditsPerMemberPerMonth'),
            max_published_decks=data.get('maxPublishedDecks'),
            grantable_features=[PlanFeatures(v) for v in data.get('grantableFeatures')] if data.get('grantableFeatures') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
