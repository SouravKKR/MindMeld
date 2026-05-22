from typing import List
from Globals.Classes.Task.AutoGeneration.AutoGenerationSettings import AutoGenerationSettings
from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.AutomationLevels import AutomationLevels
from Globals.Classes.Decorators.ExtractableInformationSource import ExtractableInformationSource


class MockTestGenerationSettings(AutoGenerationSettings):
    def __init__(self, type: TaskTypes = None, additional_instructions: str = '', description: str = '', information_sources: List[ExtractableInformationSource] = [], enhance_images: bool = False, image_sources: List[ExtractableInformationSource] = [], subject_name: str = '', exam_name: str = '', num_tests_method: AutomationLevels = AutomationLevels(0), number_of_tests: int = 2, difficulty_method: AutomationLevels = AutomationLevels(0), very_easy_questions: float = 1, easy_questions: float = 1, medium_questions: float = 1, hard_questions: float = 1, very_hard_questions: float = 1, question_types_method: AutomationLevels = AutomationLevels(0), question_types_with_weights: dict = {}, num_questions_method: AutomationLevels = AutomationLevels(0), num_questions_per_test: int = 30, correct_marks: float = 4, wrong_marks: float = -1, unattempted_marks: float = 0, partial_marks: float = 0, per_type_marking_overrides: dict = {}, section_structure: list = [], show_solving_steps: bool = True, duration_minutes: int = 0) -> None:
        super().__init__(type=type, additional_instructions=additional_instructions, description=description, information_sources=information_sources, enhance_images=enhance_images, image_sources=image_sources, subject_name=subject_name, exam_name=exam_name)
        self.set_num_tests_method(num_tests_method)
        self.set_number_of_tests(number_of_tests)
        self.set_difficulty_method(difficulty_method)
        self.set_very_easy_questions(very_easy_questions)
        self.set_easy_questions(easy_questions)
        self.set_medium_questions(medium_questions)
        self.set_hard_questions(hard_questions)
        self.set_very_hard_questions(very_hard_questions)
        self.set_question_types_method(question_types_method)
        self.set_question_types_with_weights(question_types_with_weights)
        self.set_num_questions_method(num_questions_method)
        self.set_num_questions_per_test(num_questions_per_test)
        self.set_correct_marks(correct_marks)
        self.set_wrong_marks(wrong_marks)
        self.set_unattempted_marks(unattempted_marks)
        self.set_partial_marks(partial_marks)
        self.set_per_type_marking_overrides(per_type_marking_overrides)
        self.set_section_structure(section_structure)
        self.set_show_solving_steps(show_solving_steps)
        self.set_duration_minutes(duration_minutes)

    def get_num_tests_method(self) -> AutomationLevels:
        return self.__num_tests_method

    def set_num_tests_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__num_tests_method = value

    def get_number_of_tests(self) -> int:
        return self.__number_of_tests

    def set_number_of_tests(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
            except (ValueError, TypeError):
                value = 2
        self.__number_of_tests = value

    def get_difficulty_method(self) -> AutomationLevels:
        return self.__difficulty_method

    def set_difficulty_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__difficulty_method = value

    def get_very_easy_questions(self) -> float:
        return self.__very_easy_questions

    def set_very_easy_questions(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 1
        self.__very_easy_questions = value

    def get_easy_questions(self) -> float:
        return self.__easy_questions

    def set_easy_questions(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 1
        self.__easy_questions = value

    def get_medium_questions(self) -> float:
        return self.__medium_questions

    def set_medium_questions(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 1
        self.__medium_questions = value

    def get_hard_questions(self) -> float:
        return self.__hard_questions

    def set_hard_questions(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 1
        self.__hard_questions = value

    def get_very_hard_questions(self) -> float:
        return self.__very_hard_questions

    def set_very_hard_questions(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 1
        self.__very_hard_questions = value

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

    def get_num_questions_method(self) -> AutomationLevels:
        return self.__num_questions_method

    def set_num_questions_method(self, value: AutomationLevels) -> None:
        if value is not None:
            valid_values = list(AutomationLevels)
            if value not in valid_values:
                value = valid_values[0] if valid_values else None
        self.__num_questions_method = value

    def get_num_questions_per_test(self) -> int:
        return self.__num_questions_per_test

    def set_num_questions_per_test(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
            except (ValueError, TypeError):
                value = 30
        self.__num_questions_per_test = value

    def get_correct_marks(self) -> float:
        return self.__correct_marks

    def set_correct_marks(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 4
        self.__correct_marks = value

    def get_wrong_marks(self) -> float:
        return self.__wrong_marks

    def set_wrong_marks(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = -1
        self.__wrong_marks = value

    def get_unattempted_marks(self) -> float:
        return self.__unattempted_marks

    def set_unattempted_marks(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 0
        self.__unattempted_marks = value

    def get_partial_marks(self) -> float:
        return self.__partial_marks

    def set_partial_marks(self, value: float) -> None:
        if value is not None:
            try:
                value = float(value)
            except (ValueError, TypeError):
                value = 0
        self.__partial_marks = value

    def get_per_type_marking_overrides(self) -> dict:
        return self.__per_type_marking_overrides

    def set_per_type_marking_overrides(self, value: dict) -> None:
        self.__per_type_marking_overrides = value

    def get_section_structure(self) -> list:
        return self.__section_structure

    def set_section_structure(self, value: list) -> None:
        if value is not None:
            if not isinstance(value, list):
                value = None
        self.__section_structure = value

    def get_show_solving_steps(self) -> bool:
        return self.__show_solving_steps

    def set_show_solving_steps(self, value: bool) -> None:
        if value is not None:
            value = bool(value)
        self.__show_solving_steps = value

    def get_duration_minutes(self) -> int:
        return self.__duration_minutes

    def set_duration_minutes(self, value: int) -> None:
        if value is not None:
            try:
                value = int(value)
            except (ValueError, TypeError):
                value = 0
        self.__duration_minutes = value

    def to_json(self) -> dict:
        return {
            **super().to_json(),
            'numTestsMethod': int(self.get_num_tests_method().value) if self.get_num_tests_method() is not None else None,
            'numberOfTests': self.get_number_of_tests(),
            'difficultyMethod': int(self.get_difficulty_method().value) if self.get_difficulty_method() is not None else None,
            'veryEasyQuestions': self.get_very_easy_questions(),
            'easyQuestions': self.get_easy_questions(),
            'mediumQuestions': self.get_medium_questions(),
            'hardQuestions': self.get_hard_questions(),
            'veryHardQuestions': self.get_very_hard_questions(),
            'questionTypesMethod': int(self.get_question_types_method().value) if self.get_question_types_method() is not None else None,
            'questionTypesWithWeights': self.get_question_types_with_weights(),
            'numQuestionsMethod': int(self.get_num_questions_method().value) if self.get_num_questions_method() is not None else None,
            'numQuestionsPerTest': self.get_num_questions_per_test(),
            'correctMarks': self.get_correct_marks(),
            'wrongMarks': self.get_wrong_marks(),
            'unattemptedMarks': self.get_unattempted_marks(),
            'partialMarks': self.get_partial_marks(),
            'perTypeMarkingOverrides': self.get_per_type_marking_overrides(),
            'sectionStructure': self.get_section_structure(),
            'showSolvingSteps': self.get_show_solving_steps(),
            'durationMinutes': self.get_duration_minutes(),
        }

    @classmethod
    def from_json(cls, data: dict) -> 'MockTestGenerationSettings':
        instance = cls(
            type=TaskTypes(data.get('type')) if data.get('type') is not None else None,
            additional_instructions=data.get('additionalInstructions'),
            description=data.get('description'),
            information_sources=[ExtractableInformationSource.from_json(v) for v in data.get('informationSources')] if data.get('informationSources') is not None else None,
            enhance_images=data.get('enhanceImages'),
            image_sources=[ExtractableInformationSource.from_json(v) for v in data.get('imageSources')] if data.get('imageSources') is not None else None,
            subject_name=data.get('subjectName'),
            exam_name=data.get('examName'),
            num_tests_method=AutomationLevels(data.get('numTestsMethod')) if data.get('numTestsMethod') is not None else None,
            number_of_tests=data.get('numberOfTests'),
            difficulty_method=AutomationLevels(data.get('difficultyMethod')) if data.get('difficultyMethod') is not None else None,
            very_easy_questions=data.get('veryEasyQuestions'),
            easy_questions=data.get('easyQuestions'),
            medium_questions=data.get('mediumQuestions'),
            hard_questions=data.get('hardQuestions'),
            very_hard_questions=data.get('veryHardQuestions'),
            question_types_method=AutomationLevels(data.get('questionTypesMethod')) if data.get('questionTypesMethod') is not None else None,
            question_types_with_weights=data.get('questionTypesWithWeights'),
            num_questions_method=AutomationLevels(data.get('numQuestionsMethod')) if data.get('numQuestionsMethod') is not None else None,
            num_questions_per_test=data.get('numQuestionsPerTest'),
            correct_marks=data.get('correctMarks'),
            wrong_marks=data.get('wrongMarks'),
            unattempted_marks=data.get('unattemptedMarks'),
            partial_marks=data.get('partialMarks'),
            per_type_marking_overrides=data.get('perTypeMarkingOverrides'),
            section_structure=data.get('sectionStructure'),
            show_solving_steps=data.get('showSolvingSteps'),
            duration_minutes=data.get('durationMinutes')
        )
        if data.get('id') is not None:
            instance._restore_id_id(data.get('id'))
        return instance
