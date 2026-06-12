# One additive term of a CreditSpendRule. Mirrors
# Dock/Globals/Classes/Credits/CreditSpendTerm.js — the cost math MUST stay
# byte-identical across the two services. The term's cost is its `credits`
# coefficient multiplied by the product of (metric / divisor) over every
# dimension it declares. A term with no divisors is flat and always
# contributes its coefficient (this is the ON_START semantics).
#
# `divisors` is keyed by CreditCostDimensions name (e.g. "INPUT_TOKENS").


class CreditSpendTerm:

    def __init__(self, credits: float = 0, divisors: dict = None) -> None:
        self.set_credits(credits)
        self.set_divisors(divisors if divisors is not None else {})

    def get_credits(self) -> float:
        return self.__credits

    def set_credits(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        self.__credits = value

    def get_divisors(self) -> dict:
        return self.__divisors

    def set_divisors(self, value) -> None:
        sanitized_divisors = {}
        if isinstance(value, dict):
            for dimension_name in value:
                try:
                    divisor = float(value[dimension_name])
                except (TypeError, ValueError):
                    continue
                if divisor > 0:
                    sanitized_divisors[dimension_name] = divisor
        self.__divisors = sanitized_divisors

    def evaluate(self, metrics: dict) -> float:
        amount = self.__credits
        for dimension_name, divisor in self.__divisors.items():
            metric_value = metrics.get(dimension_name, 0) if isinstance(metrics, dict) else 0
            try:
                metric_value = float(metric_value)
            except (TypeError, ValueError):
                metric_value = 0
            amount *= (metric_value / divisor)
        return amount

    def to_json(self) -> dict:
        return {
            "credits": self.get_credits(),
            "divisors": dict(self.get_divisors()),
        }

    @classmethod
    def from_json(cls, data: dict) -> "CreditSpendTerm":
        data = data or {}
        return cls(
            credits=data.get("credits", 0),
            divisors=data.get("divisors", {}),
        )
