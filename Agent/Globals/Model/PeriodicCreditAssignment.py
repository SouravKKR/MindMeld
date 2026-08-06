import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.PeriodicScopeTypes import PeriodicScopeTypes
from Globals.Enumerations.TagMatchModes import TagMatchModes
from Globals.Enumerations.CreditGrantAmountModes import CreditGrantAmountModes
from Globals.Enumerations.PeriodicScheduleTypes import PeriodicScheduleTypes
from Globals.Enumerations.PeriodicOnJoinModes import PeriodicOnJoinModes
from Globals.Enumerations.PeriodicAssignmentStatuses import PeriodicAssignmentStatuses


class PeriodicCreditAssignment:
    def __init__(self, name: str = None, scope_type: PeriodicScopeTypes = PeriodicScopeTypes(0), organization_id: str = '', people_emails: list = [], tag_filter: List[str] = [], tag_match_mode: TagMatchModes = TagMatchModes(0), amount: float = 0, amount_mode: CreditGrantAmountModes = CreditGrantAmountModes(1), schedule_type: PeriodicScheduleTypes = PeriodicScheduleTypes(0), interval_days: int = 0, day_of_week: int = 0, day_of_month: int = 1, on_join_mode: PeriodicOnJoinModes = PeriodicOnJoinModes(0), start_at: datetime = datetime.now(), has_valid_until: bool = False, valid_until: datetime = datetime.now(), status: PeriodicAssignmentStatuses = PeriodicAssignmentStatuses(0), terminated_at: datetime = datetime.now(), created_by_user_id: str = '', created_at: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_name(name)
        self.set_scope_type(scope_type)
        self.set_organization_id(organization_id)
        self.set_people_emails(people_emails)
        self.set_tag_filter(tag_filter)
        self.set_tag_match_mode(tag_match_mode)
        self.set_amount(amount)
        self.set_amount_mode(amount_mode)
        self.set_schedule_type(schedule_type)
        self.set_interval_days(interval_days)
        self.set_day_of_week(day_of_week)
        self.set_day_of_month(day_of_month)
        self.set_on_join_mode(on_join_mode)
        self.set_start_at(start_at)
        self.set_has_valid_until(has_valid_until)
        self.set_valid_until(valid_until)
        self.set_status(status)
        self.set_terminated_at(terminated_at)
        self.set_created_by_user_id(created_by_user_id)
        self.set_created_at(created_at)
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

    def get_scope_type(self) -> PeriodicScopeTypes:
        return self.__scope_type

    def set_scope_type(self, value: PeriodicScopeTypes) -> None:
        if value is not None:
            valid_values = list(PeriodicScopeTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__scope_type = value

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_people_emails(self) -> list:
        return self.__people_emails

    def set_people_emails(self, value: list) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__people_emails = value

    def get_tag_filter(self) -> List[str]:
        return self.__tag_filter

    def set_tag_filter(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__tag_filter = value

    def get_tag_match_mode(self) -> TagMatchModes:
        return self.__tag_match_mode

    def set_tag_match_mode(self, value: TagMatchModes) -> None:
        if value is not None:
            valid_values = list(TagMatchModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__tag_match_mode = value

    def get_amount(self) -> float:
        return self.__amount

    def set_amount(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__amount = value

    def get_amount_mode(self) -> CreditGrantAmountModes:
        return self.__amount_mode

    def set_amount_mode(self, value: CreditGrantAmountModes) -> None:
        if value is not None:
            valid_values = list(CreditGrantAmountModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__amount_mode = value

    def get_schedule_type(self) -> PeriodicScheduleTypes:
        return self.__schedule_type

    def set_schedule_type(self, value: PeriodicScheduleTypes) -> None:
        if value is not None:
            valid_values = list(PeriodicScheduleTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__schedule_type = value

    def get_interval_days(self) -> int:
        return self.__interval_days

    def set_interval_days(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__interval_days = value

    def get_day_of_week(self) -> int:
        return self.__day_of_week

    def set_day_of_week(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, min(value, 6))
            except (ValueError, TypeError):
                value = 0
        self.__day_of_week = value

    def get_day_of_month(self) -> int:
        return self.__day_of_month

    def set_day_of_month(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(1, min(value, 31))
            except (ValueError, TypeError):
                value = 1
        self.__day_of_month = value

    def get_on_join_mode(self) -> PeriodicOnJoinModes:
        return self.__on_join_mode

    def set_on_join_mode(self, value: PeriodicOnJoinModes) -> None:
        if value is not None:
            valid_values = list(PeriodicOnJoinModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__on_join_mode = value

    def get_start_at(self) -> datetime:
        return self.__start_at

    def set_start_at(self, value: datetime) -> None:
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
        self.__start_at = value

    def get_has_valid_until(self) -> bool:
        return self.__has_valid_until

    def set_has_valid_until(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__has_valid_until = value

    def get_valid_until(self) -> datetime:
        return self.__valid_until

    def set_valid_until(self, value: datetime) -> None:
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
        self.__valid_until = value

    def get_status(self) -> PeriodicAssignmentStatuses:
        return self.__status

    def set_status(self, value: PeriodicAssignmentStatuses) -> None:
        if value is not None:
            valid_values = list(PeriodicAssignmentStatuses)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_terminated_at(self) -> datetime:
        return self.__terminated_at

    def set_terminated_at(self, value: datetime) -> None:
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
        self.__terminated_at = value

    def get_created_by_user_id(self) -> str:
        return self.__created_by_user_id

    def set_created_by_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__created_by_user_id = value

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
            'scopeType': int(self.get_scope_type().value) if self.get_scope_type() is not None else None,
            'organizationId': self.get_organization_id(),
            'peopleEmails': self.get_people_emails(),
            'tagFilter': self.get_tag_filter(),
            'tagMatchMode': int(self.get_tag_match_mode().value) if self.get_tag_match_mode() is not None else None,
            'amount': self.get_amount(),
            'amountMode': int(self.get_amount_mode().value) if self.get_amount_mode() is not None else None,
            'scheduleType': int(self.get_schedule_type().value) if self.get_schedule_type() is not None else None,
            'intervalDays': self.get_interval_days(),
            'dayOfWeek': self.get_day_of_week(),
            'dayOfMonth': self.get_day_of_month(),
            'onJoinMode': int(self.get_on_join_mode().value) if self.get_on_join_mode() is not None else None,
            'startAt': self.get_start_at().isoformat() if self.get_start_at() is not None else None,
            'hasValidUntil': self.get_has_valid_until(),
            'validUntil': self.get_valid_until().isoformat() if self.get_valid_until() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'terminatedAt': self.get_terminated_at().isoformat() if self.get_terminated_at() is not None else None,
            'createdByUserId': self.get_created_by_user_id(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PeriodicCreditAssignment':
        instance = cls(
            name=data.get('name'),
            scope_type=PeriodicScopeTypes(data.get('scopeType')) if data.get('scopeType') is not None else None,
            organization_id=data.get('organizationId'),
            people_emails=data.get('peopleEmails'),
            tag_filter=data.get('tagFilter'),
            tag_match_mode=TagMatchModes(data.get('tagMatchMode')) if data.get('tagMatchMode') is not None else None,
            amount=data.get('amount'),
            amount_mode=CreditGrantAmountModes(data.get('amountMode')) if data.get('amountMode') is not None else None,
            schedule_type=PeriodicScheduleTypes(data.get('scheduleType')) if data.get('scheduleType') is not None else None,
            interval_days=data.get('intervalDays'),
            day_of_week=data.get('dayOfWeek'),
            day_of_month=data.get('dayOfMonth'),
            on_join_mode=PeriodicOnJoinModes(data.get('onJoinMode')) if data.get('onJoinMode') is not None else None,
            start_at=datetime.fromisoformat(data.get('startAt')) if data.get('startAt') is not None else None,
            has_valid_until=data.get('hasValidUntil'),
            valid_until=datetime.fromisoformat(data.get('validUntil')) if data.get('validUntil') is not None else None,
            status=PeriodicAssignmentStatuses(data.get('status')) if data.get('status') is not None else None,
            terminated_at=datetime.fromisoformat(data.get('terminatedAt')) if data.get('terminatedAt') is not None else None,
            created_by_user_id=data.get('createdByUserId'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
