from Globals.Classes.Automation.AutomationResponse import AutomationResponse
from Globals.Utility.StripJsonMarkdown import strip_json_markdown


def build_validator(all_type_names: set, all_difficulty_names: set, expected_count: int):
    def validator(response: AutomationResponse) -> bool:
        try:
            data = response.get_output().get_data()
            parsed = strip_json_markdown(data) if isinstance(data, str) else data

            if not isinstance(parsed, list) or len(parsed) == 0:
                return False

            for card in parsed:
                if not isinstance(card, dict):
                    return False
                if not all(key in card for key in ("question", "answer", "type", "difficulty", "markedForReview")):
                    return False
                if card["type"] not in all_type_names:
                    return False
                if card["difficulty"] not in all_difficulty_names:
                    return False
                if not isinstance(card["markedForReview"], bool):
                    return False

            actual_count = len(parsed)
            difference = abs(actual_count - expected_count)
            threshold = expected_count * 0.10

            if difference > 2 and difference > threshold:
                return False

            return True
        except Exception:
            return False

    return validator


def build_thin_batch_validator(all_type_names: set, all_difficulty_names: set):
    def validator(response: AutomationResponse) -> bool:
        try:
            data = response.get_output().get_data()
            parsed = strip_json_markdown(data) if isinstance(data, str) else data

            if not isinstance(parsed, list) or len(parsed) == 0:
                return False

            for topic_entry in parsed:
                if not isinstance(topic_entry, dict):
                    return False
                if "topicChain" not in topic_entry or "cards" not in topic_entry:
                    return False
                if not isinstance(topic_entry["topicChain"], list):
                    return False
                if not isinstance(topic_entry["cards"], list) or len(topic_entry["cards"]) == 0:
                    return False

                for card in topic_entry["cards"]:
                    if not isinstance(card, dict):
                        return False
                    if not all(key in card for key in ("question", "answer", "type", "difficulty", "markedForReview")):
                        return False
                    if card["type"] not in all_type_names:
                        return False
                    if card["difficulty"] not in all_difficulty_names:
                        return False
                    if not isinstance(card["markedForReview"], bool):
                        return False

            return True
        except Exception:
            return False

    return validator