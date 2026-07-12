import uuid
from datetime import datetime


class PaidDeckPricing:
    def __init__(self, deck_id: str = None, region: str = 'GLOBAL', price_minor: int = 0, currency: str = 'INR', discount_percent: float = 0, duration_days: int = 0, is_perpetual: bool = False, effective_from: datetime = datetime.now(), effective_until: datetime = datetime.now(), additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_deck_id(deck_id)
        self.set_region(region)
        self.set_price_minor(price_minor)
        self.set_currency(currency)
        self.set_discount_percent(discount_percent)
        self.set_duration_days(duration_days)
        self.set_is_perpetual(is_perpetual)
        self.set_effective_from(effective_from)
        self.set_effective_until(effective_until)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_deck_id(self) -> str:
        return self.__deck_id

    def set_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__deck_id = value

    def get_region(self) -> str:
        return self.__region

    def set_region(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 16:
                value = value[:16]
        self.__region = value

    def get_price_minor(self) -> int:
        return self.__price_minor

    def set_price_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__price_minor = value

    def get_currency(self) -> str:
        return self.__currency

    def set_currency(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 8:
                value = value[:8]
        self.__currency = value

    def get_discount_percent(self) -> float:
        return self.__discount_percent

    def set_discount_percent(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, min(value, 100))
            except (ValueError, TypeError):
                value = 0
        self.__discount_percent = value

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

    def get_is_perpetual(self) -> bool:
        return self.__is_perpetual

    def set_is_perpetual(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__is_perpetual = value

    def get_effective_from(self) -> datetime:
        return self.__effective_from

    def set_effective_from(self, value: datetime) -> None:
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
        self.__effective_from = value

    def get_effective_until(self) -> datetime:
        return self.__effective_until

    def set_effective_until(self, value: datetime) -> None:
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
        self.__effective_until = value

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
            'deckId': self.get_deck_id(),
            'region': self.get_region(),
            'priceMinor': self.get_price_minor(),
            'currency': self.get_currency(),
            'discountPercent': self.get_discount_percent(),
            'durationDays': self.get_duration_days(),
            'isPerpetual': self.get_is_perpetual(),
            'effectiveFrom': self.get_effective_from().isoformat() if self.get_effective_from() is not None else None,
            'effectiveUntil': self.get_effective_until().isoformat() if self.get_effective_until() is not None else None,
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PaidDeckPricing':
        instance = cls(
            deck_id=data.get('deckId'),
            region=data.get('region'),
            price_minor=data.get('priceMinor'),
            currency=data.get('currency'),
            discount_percent=data.get('discountPercent'),
            duration_days=data.get('durationDays'),
            is_perpetual=data.get('isPerpetual'),
            effective_from=datetime.fromisoformat(data.get('effectiveFrom')) if data.get('effectiveFrom') is not None else None,
            effective_until=datetime.fromisoformat(data.get('effectiveUntil')) if data.get('effectiveUntil') is not None else None,
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
