from typing import List
from Globals.Classes.Task.AutoGeneration.AutoGenerationSettings import AutoGenerationSettings
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.StudyMaterialDetailLevels import StudyMaterialDetailLevels
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource


class StudyMaterialGenerationSettings(AutoGenerationSettings):
    def __init__(self, type: TaskTypes = None, additional_instructions: str = '', description: str = '', information_sources: List[ExtractableInformationSource] = [], enhance_images: bool = False, image_sources: List[ExtractableInformationSource] = [], subject_name: str = '', exam_name: str = '', detail_levels: List[StudyMaterialDetailLevels] = [StudyMaterialDetailLevels(1)]) -> None:
        super().__init__(type=type, additional_instructions=additional_instructions, description=description, information_sources=information_sources, enhance_images=enhance_images, image_sources=image_sources, subject_name=subject_name, exam_name=exam_name)
        self.set_detail_levels(detail_levels)

    def get_detail_levels(self) -> List[StudyMaterialDetailLevels]:
        return self.__detail_levels

    def set_detail_levels(self, value: List[StudyMaterialDetailLevels]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__detail_levels = value

    def to_json(self) -> dict:
        return {
            **super().to_json(),
            'detailLevels': [int(item.value) for item in self.get_detail_levels()] if self.get_detail_levels() is not None else None,
        }

    @classmethod
    def from_json(cls, data: dict) -> 'StudyMaterialGenerationSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            additional_instructions=data.get('additionalInstructions'),
            description=data.get('description'),
            information_sources=[ExtractableInformationSource.from_json(v) for v in data.get('informationSources')] if data.get('informationSources') is not None else None,
            enhance_images=data.get('enhanceImages'),
            image_sources=[ExtractableInformationSource.from_json(v) for v in data.get('imageSources')] if data.get('imageSources') is not None else None,
            subject_name=data.get('subjectName'),
            exam_name=data.get('examName'),
            detail_levels=[StudyMaterialDetailLevels(v) for v in data.get('detailLevels')] if data.get('detailLevels') is not None else None
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
