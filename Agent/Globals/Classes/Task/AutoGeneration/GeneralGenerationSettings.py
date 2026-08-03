from typing import List
from Globals.Classes.Task.AutoGeneration.AutoGenerationSettings import AutoGenerationSettings
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.AutomaticGenerationModes import AutomaticGenerationModes
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource


class GeneralGenerationSettings(AutoGenerationSettings):
    def __init__(self, type: TaskTypes = None, additional_instructions: str = '', description: str = '', information_sources: List[ExtractableInformationSource] = [], enhance_images: bool = False, image_sources: List[ExtractableInformationSource] = [], subject_name: str = '', exam_name: str = '', generation_mode: AutomaticGenerationModes = AutomaticGenerationModes(0), inherit_image_curriculum_from_information_sources: bool = True, capture_images_enabled: bool = False, good_quality_deck_short_names: bool = False, paid_deck_mode: bool = False) -> None:
        super().__init__(type=type, additional_instructions=additional_instructions, description=description, information_sources=information_sources, enhance_images=enhance_images, image_sources=image_sources, subject_name=subject_name, exam_name=exam_name)
        self.set_generation_mode(generation_mode)
        self.set_inherit_image_curriculum_from_information_sources(inherit_image_curriculum_from_information_sources)
        self.set_capture_images_enabled(capture_images_enabled)
        self.set_good_quality_deck_short_names(good_quality_deck_short_names)
        self.set_paid_deck_mode(paid_deck_mode)

    def get_generation_mode(self) -> AutomaticGenerationModes:
        return self.__generation_mode

    def set_generation_mode(self, value: AutomaticGenerationModes) -> None:
        if value is not None:
            valid_values = list(AutomaticGenerationModes)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__generation_mode = value

    def get_inherit_image_curriculum_from_information_sources(self) -> bool:
        return self.__inherit_image_curriculum_from_information_sources

    def set_inherit_image_curriculum_from_information_sources(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__inherit_image_curriculum_from_information_sources = value

    def get_capture_images_enabled(self) -> bool:
        return self.__capture_images_enabled

    def set_capture_images_enabled(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__capture_images_enabled = value

    def get_good_quality_deck_short_names(self) -> bool:
        return self.__good_quality_deck_short_names

    def set_good_quality_deck_short_names(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__good_quality_deck_short_names = value

    def get_paid_deck_mode(self) -> bool:
        return self.__paid_deck_mode

    def set_paid_deck_mode(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__paid_deck_mode = value

    def to_json(self) -> dict:
        return {
            **super().to_json(),
            'generationMode': int(self.get_generation_mode().value) if self.get_generation_mode() is not None else None,
            'inheritImageCurriculumFromInformationSources': self.get_inherit_image_curriculum_from_information_sources(),
            'captureImagesEnabled': self.get_capture_images_enabled(),
            'goodQualityDeckShortNames': self.get_good_quality_deck_short_names(),
            'paidDeckMode': self.get_paid_deck_mode(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'GeneralGenerationSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            additional_instructions=data.get('additionalInstructions'),
            description=data.get('description'),
            information_sources=[ExtractableInformationSource.from_json(v) for v in data.get('informationSources')] if data.get('informationSources') is not None else None,
            enhance_images=data.get('enhanceImages'),
            image_sources=[ExtractableInformationSource.from_json(v) for v in data.get('imageSources')] if data.get('imageSources') is not None else None,
            subject_name=data.get('subjectName'),
            exam_name=data.get('examName'),
            generation_mode=AutomaticGenerationModes(data.get('generationMode')) if data.get('generationMode') is not None else None,
            inherit_image_curriculum_from_information_sources=data.get('inheritImageCurriculumFromInformationSources'),
            capture_images_enabled=data.get('captureImagesEnabled'),
            good_quality_deck_short_names=data.get('goodQualityDeckShortNames'),
            paid_deck_mode=data.get('paidDeckMode')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
