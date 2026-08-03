import uuid
from typing import List
from Globals.Enumerations.InformationSourceTypes import InformationSourceTypes
from Globals.Enumerations.OcrModes import OcrModes
from Globals.Enumerations.ContentRetentionModes import ContentRetentionModes
from Globals.Enumerations.CurriculumPlausibility import CurriculumPlausibility


class InformationSource:
    def __init__(self, name: str = None, user_id: str = None, source_type: InformationSourceTypes = None, directory_path: str = None, tags: List[str] = [], mime_type: str = '', hash: str = '', ocr_mode: OcrModes = OcrModes(1), file_size_bytes: int = 0, retention_mode: ContentRetentionModes = ContentRetentionModes(1), expires_at: int = 0, uploaded_at: int = 0, curriculum_plausibility: CurriculumPlausibility = CurriculumPlausibility(0), curriculum_plausibility_reason: str = '') -> None:
        self.__id = str(uuid.uuid4())
        self.set_name(name)
        self.set_user_id(user_id)
        self.set_source_type(source_type)
        self.set_directory_path(directory_path)
        self.set_tags(tags)
        self.set_mime_type(mime_type)
        self.set_hash(hash)
        self.set_ocr_mode(ocr_mode)
        self.set_file_size_bytes(file_size_bytes)
        self.set_retention_mode(retention_mode)
        self.set_expires_at(expires_at)
        self.set_uploaded_at(uploaded_at)
        self.set_curriculum_plausibility(curriculum_plausibility)
        self.set_curriculum_plausibility_reason(curriculum_plausibility_reason)

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

    def get_user_id(self) -> str:
        return self.__user_id

    def set_user_id(self, value: str) -> None:
        if value is not None:
            value = str(value)
            if len(value) > 256:
                value = value[:256]
            if value is not None and len(value) < 1:
                value = None
        self.__user_id = value

    def get_source_type(self) -> InformationSourceTypes:
        return self.__source_type

    def set_source_type(self, value: InformationSourceTypes) -> None:
        if value is not None:
            valid_values = list(InformationSourceTypes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__source_type = value

    def get_directory_path(self) -> str:
        return self.__directory_path

    def set_directory_path(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__directory_path = value

    def get_tags(self) -> List[str]:
        return self.__tags

    def set_tags(self, value: List[str]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__tags = value

    def get_mime_type(self) -> str:
        return self.__mime_type

    def set_mime_type(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__mime_type = value

    def get_hash(self) -> str:
        return self.__hash

    def set_hash(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__hash = value

    def get_ocr_mode(self) -> OcrModes:
        return self.__ocr_mode

    def set_ocr_mode(self, value: OcrModes) -> None:
        if value is not None:
            valid_values = list(OcrModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__ocr_mode = value

    def get_file_size_bytes(self) -> int:
        return self.__file_size_bytes

    def set_file_size_bytes(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__file_size_bytes = value

    def get_retention_mode(self) -> ContentRetentionModes:
        return self.__retention_mode

    def set_retention_mode(self, value: ContentRetentionModes) -> None:
        if value is not None:
            valid_values = list(ContentRetentionModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__retention_mode = value

    def get_expires_at(self) -> int:
        return self.__expires_at

    def set_expires_at(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__expires_at = value

    def get_uploaded_at(self) -> int:
        return self.__uploaded_at

    def set_uploaded_at(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
                value = max(0, value)
            except (ValueError, TypeError):
                value = 0
        self.__uploaded_at = value

    def get_curriculum_plausibility(self) -> CurriculumPlausibility:
        return self.__curriculum_plausibility

    def set_curriculum_plausibility(self, value: CurriculumPlausibility) -> None:
        if value is not None:
            valid_values = list(CurriculumPlausibility)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__curriculum_plausibility = value

    def get_curriculum_plausibility_reason(self) -> str:
        return self.__curriculum_plausibility_reason

    def set_curriculum_plausibility_reason(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__curriculum_plausibility_reason = value

    def _restore_id_id(self, stored_id):
        if stored_id is not None:
            self.__id = stored_id

    def to_json(self) -> dict:
        return {
            'id': self.get_id(),
            'name': self.get_name(),
            'userId': self.get_user_id(),
            'sourceType': int(self.get_source_type().value) if self.get_source_type() is not None else None,
            'directoryPath': self.get_directory_path(),
            'tags': self.get_tags(),
            'mimeType': self.get_mime_type(),
            'hash': self.get_hash(),
            'ocrMode': int(self.get_ocr_mode().value) if self.get_ocr_mode() is not None else None,
            'fileSizeBytes': self.get_file_size_bytes(),
            'retentionMode': int(self.get_retention_mode().value) if self.get_retention_mode() is not None else None,
            'expiresAt': self.get_expires_at(),
            'uploadedAt': self.get_uploaded_at(),
            'curriculumPlausibility': int(self.get_curriculum_plausibility().value) if self.get_curriculum_plausibility() is not None else None,
            'curriculumPlausibilityReason': self.get_curriculum_plausibility_reason(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'InformationSource':
        instance = cls(
            name=data.get('name'),
            user_id=data.get('userId'),
            source_type=InformationSourceTypes(data.get('sourceType')) if data.get('sourceType') is not None else None,
            directory_path=data.get('directoryPath'),
            tags=data.get('tags'),
            mime_type=data.get('mimeType'),
            hash=data.get('hash'),
            ocr_mode=OcrModes(data.get('ocrMode')) if data.get('ocrMode') is not None else None,
            file_size_bytes=data.get('fileSizeBytes'),
            retention_mode=ContentRetentionModes(data.get('retentionMode')) if data.get('retentionMode') is not None else None,
            expires_at=data.get('expiresAt'),
            uploaded_at=data.get('uploadedAt'),
            curriculum_plausibility=CurriculumPlausibility(data.get('curriculumPlausibility')) if data.get('curriculumPlausibility') is not None else None,
            curriculum_plausibility_reason=data.get('curriculumPlausibilityReason')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
