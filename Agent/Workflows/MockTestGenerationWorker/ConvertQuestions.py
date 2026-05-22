from Globals.Enumerations.QuestionTypes import QuestionTypes
from Globals.Enumerations.DifficultyLevels import DifficultyLevels


# Question types that require an options array
OPTION_BASED_TYPES = {
    QuestionTypes.MULTIPLE_CHOICE,
    QuestionTypes.MULTIPLE_CORRECT,
}


def convert_raw_questions(raw_questions: list[dict]) -> list[dict]:
    """
    Converts a list of raw LLM-output question dicts into the stored MockTestQuestion shape.

    Raw LLM shape (per question):
    {
        "question":       str,
        "expectedAnswer": str | int,    # option index (MCQ), "[0,2]" (multi), or plain text
        "answerReason":   str,
        "solvingSteps":   str,          # may be empty for subjective / recall-only questions
        "type":           str,          # QuestionTypes key  e.g. "MULTIPLE_CHOICE"
        "difficulty":     str,          # DifficultyLevels key e.g. "MEDIUM"
        "marks":          int | float,
        "options":        list[str]     # only present for MULTIPLE_CHOICE / MULTIPLE_CORRECT
    }

    Stored MockTestQuestion shape:
    {
        "question":       str,
        "expectedAnswer": str,          # stringified index / index-array / plain text
        "answerReason":   str,
        "solvingSteps":   str,          # may be empty
        "marks":          int | float,
        "answer":         "",           # always empty at generation time
        "score":          0,            # always 0 at generation time
        "additionalData": {
            "type":       int,          # QuestionTypes enum value
            "difficulty": int,          # DifficultyLevels enum value
            "options":    list[str]     # only present for option-based types
        }
    }
    """
    converted = []

    for raw in raw_questions:
        try:
            type_value       = QuestionTypes[raw["type"]].value
            difficulty_value = DifficultyLevels[raw["difficulty"]].value
        except KeyError:
            print(
                f"[ConvertQuestions] Skipping question with unrecognised type "
                f"'{raw.get('type')}' or difficulty '{raw.get('difficulty')}'."
            )
            continue

        question_type_enum = QuestionTypes[raw["type"]]

        additional_data = {
            "type":       type_value,
            "difficulty": difficulty_value,
        }

        if question_type_enum in OPTION_BASED_TYPES:
            options = raw.get("options")
            if not isinstance(options, list) or len(options) == 0:
                print(
                    f"[ConvertQuestions] Skipping {raw['type']} question with missing or "
                    f"empty options: '{raw.get('question', '')[:60]}'"
                )
                continue
            additional_data["options"] = options

        # expectedAnswer is always stored as a string
        expected_answer = raw.get("expectedAnswer", "")
        if not isinstance(expected_answer, str):
            expected_answer = str(expected_answer)

        # solvingSteps is optional in the LLM response (the prompt instructs
        # an empty string for subjective questions, but defensively accept
        # missing keys + non-string values without dropping the question).
        raw_solving_steps = raw.get("solvingSteps", "")
        solving_steps = raw_solving_steps if isinstance(raw_solving_steps, str) else str(raw_solving_steps)

        converted.append({
            "question":       raw.get("question", ""),
            "expectedAnswer": expected_answer,
            "answerReason":   raw.get("answerReason", ""),
            "solvingSteps":   solving_steps,
            "marks":          raw.get("marks", 1),
            "answer":         "",
            "score":          0,
            "additionalData": additional_data,
        })

    return converted