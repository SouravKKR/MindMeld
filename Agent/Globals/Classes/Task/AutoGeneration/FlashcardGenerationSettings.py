from typing import List
from Globals.Classes.Task.AutoGeneration.AutoGenerationSettings import AutoGenerationSettings
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.AutomationLevels import AutomationLevels
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource


class FlashcardGenerationSettings(AutoGenerationSettings):
    def __init__(self, type: TaskTypes = None, additional_instructions: str = '', description: str = '', information_sources: List[ExtractableInformationSource] = [], enhance_images: bool = False, image_sources: List[ExtractableInformationSource] = [], subject_name: str = '', exam_name: str = '', num_cards_method: AutomationLevels = AutomationLevels(0), num_questions_to_generate: int = 20, question_types_method: AutomationLevels = AutomationLevels(0), question_types_with_weights: dict = {}, difficulty_method: AutomationLevels = AutomationLevels(0), question_difficulty_with_weights: dict = {}, b_mark_questions_for_review: bool = True) -> None:
        super().__init__(type=type, additional_instructions=additional_instructions, description=description, information_sources=information_sources, enhance_images=enhance_images, image_sources=image_sources, subject_name=subject_name, exam_name=exam_name)
        self.set_num_cards_method(num_cards_method)
        self.set_num_questions_to_generate(num_questions_to_generate)
        self.set_question_types_method(question_types_method)
        self.set_question_types_with_weights(question_types_with_weights)
        self.set_difficulty_method(difficulty_method)
        self.set_question_difficulty_with_weights(question_difficulty_with_weights)
        self.set_b_mark_questions_for_review(b_mark_questions_for_review)

    def get_num_cards_method(self) -> AutomationLevels:
        return self.__num_cards_method

    def set_num_cards_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__num_cards_method = value

    def get_num_questions_to_generate(self) -> int:
        return self.__num_questions_to_generate

    def set_num_questions_to_generate(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
            except (ValueError, TypeError):
                value = 20
        self.__num_questions_to_generate = value

    def get_question_types_method(self) -> AutomationLevels:
        return self.__question_types_method

    def set_question_types_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__question_types_method = value

    def get_question_types_with_weights(self) -> dict:
        return self.__question_types_with_weights

    def set_question_types_with_weights(self, value: dict) -> None:
        self.__question_types_with_weights = value

    def get_difficulty_method(self) -> AutomationLevels:
        return self.__difficulty_method

    def set_difficulty_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__difficulty_method = value

    def get_question_difficulty_with_weights(self) -> dict:
        return self.__question_difficulty_with_weights

    def set_question_difficulty_with_weights(self, value: dict) -> None:
        self.__question_difficulty_with_weights = value

    def get_b_mark_questions_for_review(self) -> bool:
        return self.__b_mark_questions_for_review

    def set_b_mark_questions_for_review(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__b_mark_questions_for_review = value

    def to_json(self) -> dict:
        return {
            **super().to_json(),
            'numCardsMethod': int(self.get_num_cards_method().value) if self.get_num_cards_method() is not None else None,
            'numQuestionsToGenerate': self.get_num_questions_to_generate(),
            'questionTypesMethod': int(self.get_question_types_method().value) if self.get_question_types_method() is not None else None,
            'questionTypesWithWeights': self.get_question_types_with_weights(),
            'difficultyMethod': int(self.get_difficulty_method().value) if self.get_difficulty_method() is not None else None,
            'questionDifficultyWithWeights': self.get_question_difficulty_with_weights(),
            'bMarkQuestionsForReview': self.get_b_mark_questions_for_review(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'FlashcardGenerationSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            additional_instructions=data.get('additionalInstructions'),
            description=data.get('description'),
            information_sources=[ExtractableInformationSource.from_json(v) for v in data.get('informationSources')] if data.get('informationSources') is not None else None,
            enhance_images=data.get('enhanceImages'),
            image_sources=[ExtractableInformationSource.from_json(v) for v in data.get('imageSources')] if data.get('imageSources') is not None else None,
            subject_name=data.get('subjectName'),
            exam_name=data.get('examName'),
            num_cards_method=AutomationLevels(data.get('numCardsMethod')) if data.get('numCardsMethod') is not None else None,
            num_questions_to_generate=data.get('numQuestionsToGenerate'),
            question_types_method=AutomationLevels(data.get('questionTypesMethod')) if data.get('questionTypesMethod') is not None else None,
            question_types_with_weights=data.get('questionTypesWithWeights'),
            difficulty_method=AutomationLevels(data.get('difficultyMethod')) if data.get('difficultyMethod') is not None else None,
            question_difficulty_with_weights=data.get('questionDifficultyWithWeights'),
            b_mark_questions_for_review=data.get('bMarkQuestionsForReview')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
