import uuid
from datetime import datetime
from Globals.Enumerations.OrganizationPaymentKinds import OrganizationPaymentKinds
from Globals.Enumerations.OrganizationPaymentStatuses import OrganizationPaymentStatuses
from Globals.Enumerations.PaymentProviders import PaymentProviders


class OrganizationPayment:
    def __init__(self, organization_id: str = None, kind: OrganizationPaymentKinds = OrganizationPaymentKinds(0), status: OrganizationPaymentStatuses = OrganizationPaymentStatuses(0), payment_provider: PaymentProviders = PaymentProviders(0), provider_order_id: str = '', provider_payment_id: str = '', amount_minor: int = 0, currency: str = 'INR', additional_members: int = 0, created_at: datetime = datetime.now(), captured_at: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_organization_id(organization_id)
        self.set_kind(kind)
        self.set_status(status)
        self.set_payment_provider(payment_provider)
        self.set_provider_order_id(provider_order_id)
        self.set_provider_payment_id(provider_payment_id)
        self.set_amount_minor(amount_minor)
        self.set_currency(currency)
        self.set_additional_members(additional_members)
        self.set_created_at(created_at)
        self.set_captured_at(captured_at)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_organization_id(self) -> str:
        return self.__organization_id

    def set_organization_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__organization_id = value

    def get_kind(self) -> OrganizationPaymentKinds:
        return self.__kind

    def set_kind(self, value: OrganizationPaymentKinds) -> None:
        if value is not None:
            valid_values = list(OrganizationPaymentKinds)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__kind = value

    def get_status(self) -> OrganizationPaymentStatuses:
        return self.__status

    def set_status(self, value: OrganizationPaymentStatuses) -> None:
        if value is not None:
            valid_values = list(OrganizationPaymentStatuses)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

    def get_payment_provider(self) -> PaymentProviders:
        return self.__payment_provider

    def set_payment_provider(self, value: PaymentProviders) -> None:
        if value is not None:
            valid_values = list(PaymentProviders)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__payment_provider = value

    def get_provider_order_id(self) -> str:
        return self.__provider_order_id

    def set_provider_order_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__provider_order_id = value

    def get_provider_payment_id(self) -> str:
        return self.__provider_payment_id

    def set_provider_payment_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__provider_payment_id = value

    def get_amount_minor(self) -> int:
        return self.__amount_minor

    def set_amount_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__amount_minor = value

    def get_currency(self) -> str:
        return self.__currency

    def set_currency(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 8:
                value = value[:8]
        self.__currency = value

    def get_additional_members(self) -> int:
        return self.__additional_members

    def set_additional_members(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__additional_members = value

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

    def get_captured_at(self) -> datetime:
        return self.__captured_at

    def set_captured_at(self, value: datetime) -> None:
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
        self.__captured_at = value

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
            'organizationId': self.get_organization_id(),
            'kind': int(self.get_kind().value) if self.get_kind() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'paymentProvider': int(self.get_payment_provider().value) if self.get_payment_provider() is not None else None,
            'providerOrderId': self.get_provider_order_id(),
            'providerPaymentId': self.get_provider_payment_id(),
            'amountMinor': self.get_amount_minor(),
            'currency': self.get_currency(),
            'additionalMembers': self.get_additional_members(),
            'createdAt': self.get_created_at().isoformat() if self.get_created_at() is not None else None,
            'capturedAt': self.get_captured_at().isoformat() if self.get_captured_at() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'OrganizationPayment':
        instance = cls(
            organization_id=data.get('organizationId'),
            kind=OrganizationPaymentKinds(data.get('kind')) if data.get('kind') is not None else None,
            status=OrganizationPaymentStatuses(data.get('status')) if data.get('status') is not None else None,
            payment_provider=PaymentProviders(data.get('paymentProvider')) if data.get('paymentProvider') is not None else None,
            provider_order_id=data.get('providerOrderId'),
            provider_payment_id=data.get('providerPaymentId'),
            amount_minor=data.get('amountMinor'),
            currency=data.get('currency'),
            additional_members=data.get('additionalMembers'),
            created_at=datetime.fromisoformat(data.get('createdAt')) if data.get('createdAt') is not None else None,
            captured_at=datetime.fromisoformat(data.get('capturedAt')) if data.get('capturedAt') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
