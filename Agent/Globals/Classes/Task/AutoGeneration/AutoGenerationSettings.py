from typing import List
from Globals.Classes.Task.TaskSettings import TaskSettings
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource


class AutoGenerationSettings(TaskSettings):
    def __init__(self, type: TaskTypes = None, additional_instructions: str = '', description: str = '', information_sources: List[ExtractableInformationSource] = [], enhance_images: bool = False, image_sources: List[ExtractableInformationSource] = [], subject_name: str = '', exam_name: str = '') -> None:
        super().__init__(type=type)
        self.set_additional_instructions(additional_instructions)
        self.set_description(description)
        self.set_information_sources(information_sources)
        self.set_enhance_images(enhance_images)
        self.set_image_sources(image_sources)
        self.set_subject_name(subject_name)
        self.set_exam_name(exam_name)

    def get_additional_instructions(self) -> str:
        return self.__additional_instructions

    def set_additional_instructions(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__additional_instructions = value

    def get_description(self) -> str:
        return self.__description

    def set_description(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__description = value

    def get_information_sources(self) -> List[ExtractableInformationSource]:
        return self.__information_sources

    def set_information_sources(self, value: List[ExtractableInformationSource]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__information_sources = value

    def get_enhance_images(self) -> bool:
        return self.__enhance_images

    def set_enhance_images(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__enhance_images = value

    def get_image_sources(self) -> List[ExtractableInformationSource]:
        return self.__image_sources

    def set_image_sources(self, value: List[ExtractableInformationSource]) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__image_sources = value

    def get_subject_name(self) -> str:
        return self.__subject_name

    def set_subject_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__subject_name = value

    def get_exam_name(self) -> str:
        return self.__exam_name

    def set_exam_name(self, value: str) -> None:
        if value is not None:
            value = str(value)
        self.__exam_name = value

    def to_json(self) -> dict:
        return {
            **super().to_json(),
            'additionalInstructions': self.get_additional_instructions(),
            'description': self.get_description(),
            'informationSources': [item.to_json() for item in self.get_information_sources()] if self.get_information_sources() is not None else None,
            'enhanceImages': self.get_enhance_images(),
            'imageSources': [item.to_json() for item in self.get_image_sources()] if self.get_image_sources() is not None else None,
            'subjectName': self.get_subject_name(),
            'examName': self.get_exam_name(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'AutoGenerationSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            additional_instructions=data.get('additionalInstructions'),
            description=data.get('description'),
            information_sources=[ExtractableInformationSource.from_json(v) for v in data.get('informationSources')] if data.get('informationSources') is not None else None,
            enhance_images=data.get('enhanceImages'),
            image_sources=[ExtractableInformationSource.from_json(v) for v in data.get('imageSources')] if data.get('imageSources') is not None else None,
            subject_name=data.get('subjectName'),
            exam_name=data.get('examName')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
