# Mirror of Dock/Globals/Classes/Credits/CreditRewardMilestone.js.


class CreditRewardMilestone:

    def __init__(self, spend_threshold: float = 0, reward_credits: float = 0) -> None:
        self.set_spend_threshold(spend_threshold)
        self.set_reward_credits(reward_credits)

    def get_spend_threshold(self) -> float:
        return self.__spend_threshold

    def set_spend_threshold(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        if value < 0:
            value = 0
        self.__spend_threshold = value

    def get_reward_credits(self) -> float:
        return self.__reward_credits

    def set_reward_credits(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        if value < 0:
            value = 0
        self.__reward_credits = value

    def to_json(self) -> dict:
        return {
            "spendThreshold": self.get_spend_threshold(),
            "rewardCredits": self.get_reward_credits(),
        }

    @classmethod
    def from_json(cls, data: dict) -> "CreditRewardMilestone":
        data = data or {}
        return cls(
            spend_threshold=data.get("spendThreshold", 0),
            reward_credits=data.get("rewardCredits", 0),
        )
