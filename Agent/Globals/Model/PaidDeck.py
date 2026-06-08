import uuid
from datetime import datetime
from typing import List
from Globals.Enumerations.DeckPurchaseGranularity import DeckPurchaseGranularity
from Globals.Enumerations.PaidDeckFeatureBadges import PaidDeckFeatureBadges


class PaidDeck:
    def __init__(self, title: str = None, description: str = '', seller_id: str = '', thumbnail_url: str = '', category: str = '', tags: List[str] = [], base_price_minor: int = 0, currency: str = 'INR', granularity: DeckPurchaseGranularity = DeckPurchaseGranularity(0), bundle_child_ids: List[str] = [], parent_bundle_ids: List[str] = [], asset_blob_id: str = '', key_version: int = 1, is_published: bool = False, published_at: datetime = datetime.now(), feature_badges: List[PaidDeckFeatureBadges] = [], extra_tags: List[str] = [], content_summary: dict = {}, additional_data: dict = {}) -> None:
        self.__id = str(uuid.uuid4())
        self.set_title(title)
        self.set_description(description)
        self.set_seller_id(seller_id)
        self.set_thumbnail_url(thumbnail_url)
        self.set_category(category)
        self.set_tags(tags)
        self.set_base_price_minor(base_price_minor)
        self.set_currency(currency)
        self.set_granularity(granularity)
        self.set_bundle_child_ids(bundle_child_ids)
        self.set_parent_bundle_ids(parent_bundle_ids)
        self.set_asset_blob_id(asset_blob_id)
        self.set_key_version(key_version)
        self.set_is_published(is_published)
        self.set_published_at(published_at)
        self.set_feature_badges(feature_badges)
        self.set_extra_tags(extra_tags)
        self.set_content_summary(content_summary)
        self.set_additional_data(additional_data)

    def get_id(self) -> str:
        return self.__id

    def get_title(self) -> str:
        return self.__title

    def set_title(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__title = value

    def get_description(self) -> str:
        return self.__description

    def set_description(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 4096:
                value = value[:4096]
        self.__description = value

    def get_seller_id(self) -> str:
        return self.__seller_id

    def set_seller_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__seller_id = value

    def get_thumbnail_url(self) -> str:
        return self.__thumbnail_url

    def set_thumbnail_url(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 2048:
                value = value[:2048]
        self.__thumbnail_url = value

    def get_category(self) -> str:
        return self.__category

    def set_category(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 128:
                value = value[:128]
        self.__category = value

    def get_tags(self) -> List[str]:
        return self.__tags

    def set_tags(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__tags = value

    def get_base_price_minor(self) -> int:
        return self.__base_price_minor

    def set_base_price_minor(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__base_price_minor = value

    def get_currency(self) -> str:
        return self.__currency

    def set_currency(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 8:
                value = value[:8]
        self.__currency = value

    def get_granularity(self) -> DeckPurchaseGranularity:
        return self.__granularity

    def set_granularity(self, value: DeckPurchaseGranularity) -> None:
        if value is not None:
            valid_values = list(DeckPurchaseGranularity)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__granularity = value

    def get_bundle_child_ids(self) -> List[str]:
        return self.__bundle_child_ids

    def set_bundle_child_ids(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__bundle_child_ids = value

    def get_parent_bundle_ids(self) -> List[str]:
        return self.__parent_bundle_ids

    def set_parent_bundle_ids(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__parent_bundle_ids = value

    def get_asset_blob_id(self) -> str:
        return self.__asset_blob_id

    def set_asset_blob_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__asset_blob_id = value

    def get_key_version(self) -> int:
        return self.__key_version

    def set_key_version(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(1, value)
            except (ValueError, TypeError):
                value = 1
        self.__key_version = value

    def get_is_published(self) -> bool:
        return self.__is_published

    def set_is_published(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__is_published = value

    def get_published_at(self) -> datetime:
        return self.__published_at

    def set_published_at(self, value: datetime) -> None:
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
        self.__published_at = value

    def get_feature_badges(self) -> List[PaidDeckFeatureBadges]:
        return self.__feature_badges

    def set_feature_badges(self, value: List[PaidDeckFeatureBadges]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__feature_badges = value

    def get_extra_tags(self) -> List[str]:
        return self.__extra_tags

    def set_extra_tags(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__extra_tags = value

    def get_content_summary(self) -> dict:
        return self.__content_summary

    def set_content_summary(self, value: dict) -> None:
        self.__content_summary = value

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
            'title': self.get_title(),
            'description': self.get_description(),
            'sellerId': self.get_seller_id(),
            'thumbnailUrl': self.get_thumbnail_url(),
            'category': self.get_category(),
            'tags': self.get_tags(),
            'basePriceMinor': self.get_base_price_minor(),
            'currency': self.get_currency(),
            'granularity': int(self.get_granularity().value) if self.get_granularity() is not None else None,
            'bundleChildIds': self.get_bundle_child_ids(),
            'parentBundleIds': self.get_parent_bundle_ids(),
            'assetBlobId': self.get_asset_blob_id(),
            'keyVersion': self.get_key_version(),
            'isPublished': self.get_is_published(),
            'publishedAt': self.get_published_at().isoformat() if self.get_published_at() is not None else None,
            'featureBadges': [int(item.value) for item in self.get_feature_badges()] if self.get_feature_badges() is not None else None,
            'extraTags': self.get_extra_tags(),
            'contentSummary': self.get_content_summary(),
            'additionalData': self.get_additional_data(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PaidDeck':
        instance = cls(
            title=data.get('title'),
            description=data.get('description'),
            seller_id=data.get('sellerId'),
            thumbnail_url=data.get('thumbnailUrl'),
            category=data.get('category'),
            tags=data.get('tags'),
            base_price_minor=data.get('basePriceMinor'),
            currency=data.get('currency'),
            granularity=DeckPurchaseGranularity(data.get('granularity')) if data.get('granularity') is not None else None,
            bundle_child_ids=data.get('bundleChildIds'),
            parent_bundle_ids=data.get('parentBundleIds'),
            asset_blob_id=data.get('assetBlobId'),
            key_version=data.get('keyVersion'),
            is_published=data.get('isPublished'),
            published_at=datetime.fromisoformat(data.get('publishedAt')) if data.get('publishedAt') is not None else None,
            feature_badges=[PaidDeckFeatureBadges(v) for v in data.get('featureBadges')] if data.get('featureBadges') is not None else None,
            extra_tags=data.get('extraTags'),
            content_summary=data.get('contentSummary'),
            additional_data=data.get('additionalData')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
