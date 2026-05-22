import uuid


class PaidDeckBundleDiscount:
    def __init__(self, bundle_deck_id: str = None, included_deck_id: str = None, discount_percent_when_included: float = 100) -> None:
        self.__id = str(uuid.uuid4())
        self.set_bundle_deck_id(bundle_deck_id)
        self.set_included_deck_id(included_deck_id)
        self.set_discount_percent_when_included(discount_percent_when_included)

    def get_id(self) -> str:
        return self.__id

    def get_bundle_deck_id(self) -> str:
        return self.__bundle_deck_id

    def set_bundle_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__bundle_deck_id = value

    def get_included_deck_id(self) -> str:
        return self.__included_deck_id

    def set_included_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__included_deck_id = value

    def get_discount_percent_when_included(self) -> float:
        return self.__discount_percent_when_included

    def set_discount_percent_when_included(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
                value = max(0, min(value, 100))
            except (ValueError, TypeError):
                value = 100
        self.__discount_percent_when_included = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'bundleDeckId': self.get_bundle_deck_id(),
            'includedDeckId': self.get_included_deck_id(),
            'discountPercentWhenIncluded': self.get_discount_percent_when_included(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PaidDeckBundleDiscount':
        instance = cls(
            bundle_deck_id=data.get('bundleDeckId'),
            included_deck_id=data.get('includedDeckId'),
            discount_percent_when_included=data.get('discountPercentWhenIncluded')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
