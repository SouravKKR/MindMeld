import math
from typing import Any, Dict, List, Optional, Tuple

from Globals.Enumerations.SectionQuestionCountModes import SectionQuestionCountModes
from Globals.Enumerations.SectionMarksModes import SectionMarksModes


class MockTestSectionGeometry:
    """
    Hand-mirrored from Main/Globals/Classes/MockTestSectionGeometry.js and
    Dock/Globals/Classes/Generation/MockTestSectionGeometry.js. All three copies
    MUST agree: the editor blocks submission on these rules, Dock re-checks them,
    this copy turns them into the constraint the model is generating against, and
    Dock's assembler realises them.

    A section always describes three quantities — question count, marks per
    question, and the section's total marks — but only two are ever entered:

        UNIFORM_PER_QUESTION  count + marks per question are entered,
                              total marks is derived (count x marks_per_question).
        RANGE_PER_QUESTION    a marks band per question + a total-marks budget are
                              entered, and the question count is derived as
                              ceil(total / maximum) .. floor(total / minimum).

    Entries written before marks modes existed carry only questionCount and
    totalMarks. They are read as UNIFORM_PER_QUESTION with marks per question
    back-derived from those two, so a task queued before this change keeps
    meaning exactly what it meant when it was submitted.
    """

    # Marks and totals are floats entered through number inputs, so exact
    # division is not something we can rely on: 20 / 4 can arrive as
    # 4.999999999999999. Every ceil/floor here is nudged by this tolerance so a
    # band that is exactly achievable is never reported as one question short.
    FLOATING_POINT_TOLERANCE = 0.000001

    MINIMUM_QUESTION_COUNT = 1

    @staticmethod
    def __read_positive_number(section_entry: Optional[Dict[str, Any]], field_name: str) -> float:
        if not isinstance(section_entry, dict):
            return 0.0

        raw_value = section_entry.get(field_name)
        if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
            return 0.0
        if not math.isfinite(float(raw_value)) or float(raw_value) <= 0:
            return 0.0

        return float(raw_value)

    @staticmethod
    def resolve_marks_mode(section_entry: Optional[Dict[str, Any]]) -> SectionMarksModes:
        if isinstance(section_entry, dict) and section_entry.get("marksMode") == SectionMarksModes.RANGE_PER_QUESTION.value:
            return SectionMarksModes.RANGE_PER_QUESTION
        return SectionMarksModes.UNIFORM_PER_QUESTION

    @staticmethod
    def resolve_question_count_mode(section_entry: Optional[Dict[str, Any]]) -> SectionQuestionCountModes:
        if isinstance(section_entry, dict) and section_entry.get("questionCountMode") == SectionQuestionCountModes.RANGE.value:
            return SectionQuestionCountModes.RANGE
        return SectionQuestionCountModes.FIXED

    @staticmethod
    def is_question_count_derived(section_entry: Optional[Dict[str, Any]]) -> bool:
        return MockTestSectionGeometry.resolve_marks_mode(section_entry) == SectionMarksModes.RANGE_PER_QUESTION

    @staticmethod
    def resolve_marks_per_question(section_entry: Optional[Dict[str, Any]], fallback_marks_per_question: float = 0.0) -> float:
        configured_marks = MockTestSectionGeometry.__read_positive_number(section_entry, "marksPerQuestion")
        if configured_marks > 0:
            return configured_marks

        legacy_total_marks = MockTestSectionGeometry.__read_positive_number(section_entry, "totalMarks")
        legacy_question_count = MockTestSectionGeometry.__read_positive_number(section_entry, "questionCount")
        if legacy_total_marks > 0 and legacy_question_count > 0:
            return legacy_total_marks / legacy_question_count

        if isinstance(fallback_marks_per_question, (int, float)) and fallback_marks_per_question > 0:
            return float(fallback_marks_per_question)

        return 0.0

    @staticmethod
    def resolve_marks_per_question_band(section_entry: Optional[Dict[str, Any]]) -> Tuple[float, float]:
        minimum_marks = MockTestSectionGeometry.__read_positive_number(section_entry, "marksPerQuestionMin")
        maximum_marks = MockTestSectionGeometry.__read_positive_number(section_entry, "marksPerQuestionMax")

        if maximum_marks < minimum_marks:
            maximum_marks = minimum_marks

        return (minimum_marks, maximum_marks)

    @staticmethod
    def resolve_total_marks_budget(section_entry: Optional[Dict[str, Any]]) -> float:
        return MockTestSectionGeometry.__read_positive_number(section_entry, "totalMarks")

    @staticmethod
    def resolve_question_count_band(section_entry: Optional[Dict[str, Any]]) -> Tuple[int, int]:
        if MockTestSectionGeometry.resolve_marks_mode(section_entry) == SectionMarksModes.RANGE_PER_QUESTION:
            minimum_marks, maximum_marks = MockTestSectionGeometry.resolve_marks_per_question_band(section_entry)
            total_marks_budget = MockTestSectionGeometry.resolve_total_marks_budget(section_entry)

            if minimum_marks <= 0 or maximum_marks <= 0 or total_marks_budget <= 0:
                return (0, 0)

            minimum_count = max(
                MockTestSectionGeometry.MINIMUM_QUESTION_COUNT,
                math.ceil(total_marks_budget / maximum_marks - MockTestSectionGeometry.FLOATING_POINT_TOLERANCE)
            )
            maximum_count = math.floor(total_marks_budget / minimum_marks + MockTestSectionGeometry.FLOATING_POINT_TOLERANCE)

            if maximum_count < minimum_count:
                return (0, 0)

            return (int(minimum_count), int(maximum_count))

        if MockTestSectionGeometry.resolve_question_count_mode(section_entry) == SectionQuestionCountModes.RANGE:
            minimum_count = int(MockTestSectionGeometry.__read_positive_number(section_entry, "questionCountMin"))
            maximum_count = int(MockTestSectionGeometry.__read_positive_number(section_entry, "questionCountMax"))

            if maximum_count < minimum_count:
                maximum_count = minimum_count

            return (minimum_count, maximum_count)

        fixed_count = int(MockTestSectionGeometry.__read_positive_number(section_entry, "questionCount"))
        return (fixed_count, fixed_count)

    @staticmethod
    def resolve_total_marks_band(section_entry: Optional[Dict[str, Any]], fallback_marks_per_question: float = 0.0) -> Tuple[float, float]:
        if MockTestSectionGeometry.resolve_marks_mode(section_entry) == SectionMarksModes.RANGE_PER_QUESTION:
            total_marks_budget = MockTestSectionGeometry.resolve_total_marks_budget(section_entry)
            return (total_marks_budget, total_marks_budget)

        marks_per_question = MockTestSectionGeometry.resolve_marks_per_question(section_entry, fallback_marks_per_question)
        minimum_count, maximum_count = MockTestSectionGeometry.resolve_question_count_band(section_entry)

        return (minimum_count * marks_per_question, maximum_count * marks_per_question)

    @staticmethod
    def resolve_expected_question_count(section_entry: Optional[Dict[str, Any]]) -> int:
        minimum_count, maximum_count = MockTestSectionGeometry.resolve_question_count_band(section_entry)

        if maximum_count <= minimum_count:
            return minimum_count

        if (MockTestSectionGeometry.resolve_marks_mode(section_entry) == SectionMarksModes.UNIFORM_PER_QUESTION
                and MockTestSectionGeometry.resolve_question_count_mode(section_entry) == SectionQuestionCountModes.RANGE):
            configured_weights = section_entry.get("questionCountWeights") if isinstance(section_entry, dict) else None
            if not isinstance(configured_weights, dict):
                configured_weights = {}

            weighted_total = 0.0
            weight_sum = 0.0
            for candidate_count in range(minimum_count, maximum_count + 1):
                raw_weight = configured_weights.get(str(candidate_count))
                candidate_weight = float(raw_weight) if isinstance(raw_weight, (int, float)) and not isinstance(raw_weight, bool) and raw_weight >= 0 else 1.0
                weighted_total += candidate_count * candidate_weight
                weight_sum += candidate_weight

            if weight_sum > 0:
                return int(round(weighted_total / weight_sum))

        return int(round((minimum_count + maximum_count) / 2))

    @staticmethod
    def resolve_structure_question_count_band(section_structure: Optional[List[Dict[str, Any]]]) -> Tuple[int, int]:
        sections = section_structure if isinstance(section_structure, list) else []

        minimum_total = 0
        maximum_total = 0
        for section_entry in sections:
            minimum_count, maximum_count = MockTestSectionGeometry.resolve_question_count_band(section_entry)
            minimum_total += minimum_count
            maximum_total += maximum_count

        return (minimum_total, maximum_total)

    @staticmethod
    def resolve_marks_band_for_question_type(section_structure: Optional[List[Dict[str, Any]]], type_key: str,
                                             fallback_marks_per_question: float = 0.0) -> Optional[Tuple[float, float]]:
        """
        The marks a question of `type_key` is allowed to be worth, unioned across
        every section that admits the type.

        Returns None when no section constrains the type — a section with no
        question-type filter accepts anything, so it cannot narrow any single
        type, and a run with no sections at all is left exactly as it was before
        section constraints existed.
        """
        sections = section_structure if isinstance(section_structure, list) else []

        union_minimum = None
        union_maximum = None

        for section_entry in sections:
            if not isinstance(section_entry, dict):
                continue

            allowed_type_keys = section_entry.get("questionTypes")
            if not isinstance(allowed_type_keys, list) or len(allowed_type_keys) == 0:
                # An unfiltered section accepts every type, so it cannot bound one.
                return None

            if type_key not in allowed_type_keys:
                continue

            if MockTestSectionGeometry.resolve_marks_mode(section_entry) == SectionMarksModes.RANGE_PER_QUESTION:
                minimum_marks, maximum_marks = MockTestSectionGeometry.resolve_marks_per_question_band(section_entry)
            else:
                uniform_marks = MockTestSectionGeometry.resolve_marks_per_question(section_entry, fallback_marks_per_question)
                minimum_marks = uniform_marks
                maximum_marks = uniform_marks

            if minimum_marks <= 0 or maximum_marks <= 0:
                return None

            union_minimum = minimum_marks if union_minimum is None else min(union_minimum, minimum_marks)
            union_maximum = maximum_marks if union_maximum is None else max(union_maximum, maximum_marks)

        if union_minimum is None or union_maximum is None:
            return None

        return (union_minimum, union_maximum)

    @staticmethod
    def format_marks(value: float) -> str:
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return "0"
        if float(value).is_integer():
            return str(int(value))
        return str(round(float(value), 2))
