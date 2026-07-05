from typing import List, Optional

from pydantic import BaseModel, Field


# Response schema for the Auto Fill Other Options helper. Weight maps use explicit
# named float fields (rather than open dictionaries) so the structured-output schema
# stays closed and the model cannot invent unknown keys. Each field name maps to a
# generation enum key by upper-casing it on the frontend (multiple_choice ->
# MULTIPLE_CHOICE, very_easy -> VERY_EASY, summary -> SUMMARY). Field names here must
# stay in sync with QuestionTypes / DifficultyLevels / StudyMaterialDetailLevels.


class QuestionTypeWeights(BaseModel):
    """Relative weights per question type. Higher means more of that type; leave a type unset to exclude it."""

    multiple_choice: Optional[float] = None
    multiple_correct: Optional[float] = None
    objective_single_word_or_phrase: Optional[float] = None
    short_subjective: Optional[float] = None
    medium_subjective: Optional[float] = None
    long_subjective: Optional[float] = None
    very_long_subjective: Optional[float] = None


class DifficultyWeights(BaseModel):
    """Relative weights per difficulty level. Higher means more questions at that level; leave a level unset to exclude it."""

    very_easy: Optional[float] = None
    easy: Optional[float] = None
    medium: Optional[float] = None
    hard: Optional[float] = None
    very_hard: Optional[float] = None


class StudyMaterialDetailLevelSelection(BaseModel):
    """Which study-material depths to produce. Set at least one to true."""

    summary: Optional[bool] = None
    standard: Optional[bool] = None
    comprehensive: Optional[bool] = None


class MockTestSection(BaseModel):

    name: str = Field(description = "Short section name.")
    question_types: List[str] = Field(
        description = (
            "Question types allowed in this section, each one of MULTIPLE_CHOICE, MULTIPLE_CORRECT, "
            "OBJECTIVE_SINGLE_WORD_OR_PHRASE, SHORT_SUBJECTIVE, MEDIUM_SUBJECTIVE, LONG_SUBJECTIVE, VERY_LONG_SUBJECTIVE."
        )
    )
    question_count: int = Field(description = "Number of questions in this section.")
    total_marks: float = Field(description = "Total marks for this section.")


class FlashcardOptions(BaseModel):

    number_of_cards: Optional[int] = Field(
        default = None,
        description = "Total number of flashcards to generate, suited to learning the subject."
    )
    question_type_weights: Optional[QuestionTypeWeights] = Field(
        default = None,
        description = (
            "Question-type mix for flashcards, chosen to build understanding rather than to copy an exam. "
            "Favour formats where the learner writes and explains the answer, weighting longer open-ended "
            "formats higher for conceptual subjects, but keep a genuine mix: include the shorter and "
            "multiple-choice formats too at a low weight rather than excluding them."
        )
    )
    difficulty_weights: Optional[DifficultyWeights] = Field(
        default = None,
        description = "Difficulty mix for flashcards, suited to the subject and the learner."
    )
    additional_instructions: Optional[str] = Field(
        default = None,
        description = "Short extra guidance for flashcard generation. Leave unset when nothing is needed."
    )


class MockTestOptions(BaseModel):

    number_of_tests: Optional[int] = Field(default = None, description = "Number of mock tests to generate.")
    questions_per_test: Optional[int] = Field(default = None, description = "Number of questions in each mock test.")
    difficulty_weights: Optional[DifficultyWeights] = Field(
        default = None,
        description = "Difficulty mix reflecting the named exam's typical difficulty."
    )
    question_type_weights: Optional[QuestionTypeWeights] = Field(
        default = None,
        description = "Question-type mix reflecting the named exam's known pattern."
    )
    duration_minutes: Optional[int] = Field(
        default = None,
        description = "Time limit for one test in minutes. Use 0 to let the system decide automatically."
    )
    correct_marks: Optional[float] = Field(default = None, description = "Marks awarded for a correct answer.")
    wrong_marks: Optional[float] = Field(default = None, description = "Marks for a wrong answer; negative to penalise.")
    unattempted_marks: Optional[float] = Field(default = None, description = "Marks for an unattempted question.")
    partial_marks: Optional[float] = Field(default = None, description = "Marks for a partially correct answer where applicable.")
    sections: Optional[List[MockTestSection]] = Field(
        default = None,
        description = "Section breakdown of one test reflecting the exam's structure. Leave unset for a single unsectioned test."
    )
    additional_instructions: Optional[str] = Field(
        default = None,
        description = "Short extra guidance for mock-test generation. Leave unset when nothing is needed."
    )


class StudyMaterialOptions(BaseModel):

    detail_levels: Optional[StudyMaterialDetailLevelSelection] = Field(
        default = None,
        description = "Which study-material depths to produce."
    )
    additional_instructions: Optional[str] = Field(
        default = None,
        description = "Short extra guidance for study-material generation. Leave unset when nothing is needed."
    )


class AutoFillGenerationOptionsResponse(BaseModel):

    general_additional_instructions: Optional[str] = Field(
        default = None,
        description = "General guidance for the whole generation. Provide only when the user gave none, and keep it short."
    )
    flashcards: Optional[FlashcardOptions] = Field(
        default = None,
        description = "Flashcard options. Provide only when flashcards are enabled and being tuned."
    )
    mock_tests: Optional[MockTestOptions] = Field(
        default = None,
        description = "Mock-test options. Provide only when mock tests are enabled and being tuned."
    )
    study_materials: Optional[StudyMaterialOptions] = Field(
        default = None,
        description = "Study-material options. Provide only when study materials are enabled and being tuned."
    )
