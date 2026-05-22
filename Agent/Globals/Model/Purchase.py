import uuid
from datetime import datetime
from Globals.Enumerations.PaymentProviders import PaymentProviders
from Globals.Enumerations.PurchaseStatuses import PurchaseStatuses


class Purchase:
    def __init__(self, user_id: str = None, deck_id: str = None, payment_provider: PaymentProviders = PaymentProviders(0), provider_order_id: str = '', provider_payment_id: str = '', amount_minor: int = 0, currency: str = 'INR', region: str = 'GLOBAL', purchase_date: datetime = datetime.now(), refunded_at: datetime = datetime.now(), status: PurchaseStatuses = PurchaseStatuses(0), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_user_id(user_id)
        self.set_deck_id(deck_id)
        self.set_payment_provider(payment_provider)
        self.set_provider_order_id(provider_order_id)
        self.set_provider_payment_id(provider_payment_id)
        self.set_amount_minor(amount_minor)
        self.set_currency(currency)
        self.set_region(region)
        self.set_purchase_date(purchase_date)
        self.set_refunded_at(refunded_at)
        self.set_status(status)
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

    def get_region(self) -> str:
        return self.__region

    def set_region(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 16:
                value = value[:16]
        self.__region = value

    def get_purchase_date(self) -> datetime:
        return self.__purchase_date

    def set_purchase_date(self, value: datetime) -> None:
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
        self.__purchase_date = value

    def get_refunded_at(self) -> datetime:
        return self.__refunded_at

    def set_refunded_at(self, value: datetime) -> None:
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
        self.__refunded_at = value

    def get_status(self) -> PurchaseStatuses:
        return self.__status

    def set_status(self, value: PurchaseStatuses) -> None:
        if value is not None:
            valid_values = list(PurchaseStatuses)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__status = value

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
            'paymentProvider': int(self.get_payment_provider().value) if self.get_payment_provider() is not None else None,
            'providerOrderId': self.get_provider_order_id(),
            'providerPaymentId': self.get_provider_payment_id(),
            'amountMinor': self.get_amount_minor(),
            'currency': self.get_currency(),
            'region': self.get_region(),
            'purchaseDate': self.get_purchase_date().isoformat() if self.get_purchase_date() is not None else None,
            'refundedAt': self.get_refunded_at().isoformat() if self.get_refunded_at() is not None else None,
            'status': int(self.get_status().value) if self.get_status() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'Purchase':
        instance = cls(
            user_id=data.get('userId'),
            deck_id=data.get('deckId'),
            payment_provider=PaymentProviders(data.get('paymentProvider')) if data.get('paymentProvider') is not None else None,
            provider_order_id=data.get('providerOrderId'),
            provider_payment_id=data.get('providerPaymentId'),
            amount_minor=data.get('amountMinor'),
            currency=data.get('currency'),
            region=data.get('region'),
            purchase_date=datetime.fromisoformat(data.get('purchaseDate')) if data.get('purchaseDate') is not None else None,
            refunded_at=datetime.fromisoformat(data.get('refundedAt')) if data.get('refundedAt') is not None else None,
            status=PurchaseStatuses(data.get('status')) if data.get('status') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
