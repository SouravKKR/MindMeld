from Globals.Enumerations.AutomationLevels import AutomationLevels


def build_question_types_instruction(topic: dict, question_types_method: AutomationLevels) -> str:
    if question_types_method == AutomationLevels.AUTOMATIC:
        allowed_types = topic["allowed_types"]

        if isinstance(allowed_types, dict):
            types_description = ", ".join(
                f"{question_type_key} (weight {weight:.2f})"
                for question_type_key, weight in allowed_types.items()
            )
            return f"Prefer these question types by weight: {types_description}. You decide the exact proportions."
        else:
            return f"You may use any of the following question types: {', '.join(allowed_types)}."
    else:
        type_distribution = topic["type_distribution"]
        types_description = ", ".join(
            f"{count} {question_type_key}"
            for question_type_key, count in type_distribution.items()
        )
        return f"Generate exactly the following question type breakdown: {types_description}."


def build_difficulty_instruction(topic: dict, difficulty_method: AutomationLevels) -> str:
    if difficulty_method == AutomationLevels.AUTOMATIC:
        return f"You may use any of the following difficulty levels: {', '.join(topic['allowed_difficulties'])}."
    else:
        difficulty_distribution = topic["difficulty_distribution"]
        difficulty_description = ", ".join(
            f"{count} {difficulty_key}"
            for difficulty_key, count in difficulty_distribution.items()
        )
        return f"Generate exactly the following difficulty breakdown: {difficulty_description}."


def build_cell_question_types_instruction(difficulty_key: str, type_key: str, cell_count: int) -> str:
    return f"Generate exactly {cell_count} {difficulty_key} {type_key} flashcard(s)."


def build_cell_difficulty_instruction(difficulty_key: str) -> str:
    return f"All cards must be {difficulty_key} difficulty."