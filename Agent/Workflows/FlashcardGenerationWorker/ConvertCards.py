from Globals.Enumerations.QuestionTypes import QuestionTypes
from Globals.Enumerations.DifficultyLevels import DifficultyLevels


def convert_raw_cards(raw_cards: list[dict]) -> list[dict]:
    converted_cards = []

    for raw_card in raw_cards:
        try:
            type_value = QuestionTypes[raw_card["type"]].value
            difficulty_value = DifficultyLevels[raw_card["difficulty"]].value
        except KeyError:
            print(f"[WARN] Skipping card with unrecognised type '{raw_card.get('type')}' or difficulty '{raw_card.get('difficulty')}'.")
            continue

        converted_cards.append({
            "question": raw_card["question"],
            "answer": raw_card["answer"],
            "additionalData": {
                "type": type_value,
                "difficulty": difficulty_value,
                "review": raw_card["markedForReview"],
            },
        })

    return converted_cards