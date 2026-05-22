
class InvoiceLineItem:
    def __init__(self, label: str = '', amount_minor: int = 0, currency: str = 'INR') -> None:
        self.set_label(label)
        self.set_amount_minor(amount_minor)
        self.set_currency(currency)

    def get_label(self) -> str:
        return self.__label

    def set_label(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__label = value

    def get_amount_minor(self) -> int:
        return self.__amount_minor

    def set_amount_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
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

    def to_json(self) -> dict:
        return {
            'label': self.get_label(),
            'amountMinor': self.get_amount_minor(),
            'currency': self.get_currency(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'InvoiceLineItem':
        instance = cls(
            label=data.get('label'),
            amount_minor=data.get('amountMinor'),
            currency=data.get('currency')
        )
        return instance
