import uuid
from Globals.Enumerations.SourceLicenceTypes import SourceLicenceTypes


class PaidDeckVerificationSource:
    def __init__(self, deck_id: str = None, information_source_id: str = '', name: str = None, source_url: str = '', content_hash: str = '', storage_path: str = '', mime_type: str = '', licence_type: SourceLicenceTypes = SourceLicenceTypes(0), licence_note: str = '', declared_by_user_id: str = '', attached_at: int = 0, detached_at: int = 0, active: bool = True) -> None:
        self.__id = str(uuid.uuid4())
        self.set_deck_id(deck_id)
        self.set_information_source_id(information_source_id)
        self.set_name(name)
        self.set_source_url(source_url)
        self.set_content_hash(content_hash)
        self.set_storage_path(storage_path)
        self.set_mime_type(mime_type)
        self.set_licence_type(licence_type)
        self.set_licence_note(licence_note)
        self.set_declared_by_user_id(declared_by_user_id)
        self.set_attached_at(attached_at)
        self.set_detached_at(detached_at)
        self.set_active(active)

    def get_id(self) -> str:
        return self.__id

    def get_deck_id(self) -> str:
        return self.__deck_id

    def set_deck_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__deck_id = value

    def get_information_source_id(self) -> str:
        return self.__information_source_id

    def set_information_source_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__information_source_id = value

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

    def get_source_url(self) -> str:
        return self.__source_url

    def set_source_url(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 2048:
                value = value[:2048]
        self.__source_url = value

    def get_content_hash(self) -> str:
        return self.__content_hash

    def set_content_hash(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__content_hash = value

    def get_storage_path(self) -> str:
        return self.__storage_path

    def set_storage_path(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 1024:
                value = value[:1024]
        self.__storage_path = value

    def get_mime_type(self) -> str:
        return self.__mime_type

    def set_mime_type(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__mime_type = value

    def get_licence_type(self) -> SourceLicenceTypes:
        return self.__licence_type

    def set_licence_type(self, value: SourceLicenceTypes) -> None:
        if value is not None:
            valid_values = list(SourceLicenceTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__licence_type = value

    def get_licence_note(self) -> str:
        return self.__licence_note

    def set_licence_note(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 1024:
                value = value[:1024]
        self.__licence_note = value

    def get_declared_by_user_id(self) -> str:
        return self.__declared_by_user_id

    def set_declared_by_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
        self.__declared_by_user_id = value

    def get_attached_at(self) -> int:
        return self.__attached_at

    def set_attached_at(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__attached_at = value

    def get_detached_at(self) -> int:
        return self.__detached_at

    def set_detached_at(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__detached_at = value

    def get_active(self) -> bool:
        return self.__active

    def set_active(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__active = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'deckId': self.get_deck_id(),
            'informationSourceId': self.get_information_source_id(),
            'name': self.get_name(),
            'sourceUrl': self.get_source_url(),
            'contentHash': self.get_content_hash(),
            'storagePath': self.get_storage_path(),
            'mimeType': self.get_mime_type(),
            'licenceType': int(self.get_licence_type().value) if self.get_licence_type() is not None else None,
            'licenceNote': self.get_licence_note(),
            'declaredByUserId': self.get_declared_by_user_id(),
            'attachedAt': self.get_attached_at(),
            'detachedAt': self.get_detached_at(),
            'active': self.get_active(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'PaidDeckVerificationSource':
        instance = cls(
            deck_id=data.get('deckId'),
            information_source_id=data.get('informationSourceId'),
            name=data.get('name'),
            source_url=data.get('sourceUrl'),
            content_hash=data.get('contentHash'),
            storage_path=data.get('storagePath'),
            mime_type=data.get('mimeType'),
            licence_type=SourceLicenceTypes(data.get('licenceType')) if data.get('licenceType') is not None else None,
            licence_note=data.get('licenceNote'),
            declared_by_user_id=data.get('declaredByUserId'),
            attached_at=data.get('attachedAt'),
            detached_at=data.get('detachedAt'),
            active=data.get('active')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
