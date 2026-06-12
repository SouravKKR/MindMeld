# Mirror of Dock/Globals/Classes/Credits/CreditSpendRule.js. A composable
# spend rule for one chargeable subject (agent task type or storage category).

from Globals.Enumerations.CreditDeductionTimings import CreditDeductionTimings
from Globals.Classes.Credits.CreditSpendTerm import CreditSpendTerm


class CreditSpendRule:

    DEFAULT_INTERVAL_SECONDS = 30

    def __init__(self, enabled: bool = False, deduction_timing: CreditDeductionTimings = CreditDeductionTimings.ON_SUCCESS, interval_seconds: float = None, minimum_balance_to_run=0, minimum_balance_floor=0, terms: list = None) -> None:
        self.set_enabled(enabled)
        self.set_deduction_timing(deduction_timing)
        self.set_interval_seconds(interval_seconds if interval_seconds is not None else CreditSpendRule.DEFAULT_INTERVAL_SECONDS)
        self.set_minimum_balance_to_run(minimum_balance_to_run)
        self.set_minimum_balance_floor(minimum_balance_floor)
        self.set_terms(terms if terms is not None else [])

    def get_minimum_balance_to_run(self):
        # Minimum balance a user must already hold for this task to be allowed
        # to run at all. 0 = no entry requirement.
        return self.__minimum_balance_to_run

    def set_minimum_balance_to_run(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        if value < 0:
            value = 0
        self.__minimum_balance_to_run = value

    def get_enabled(self) -> bool:
        return self.__enabled

    def set_enabled(self, value) -> None:
        self.__enabled = bool(value)

    def get_deduction_timing(self) -> CreditDeductionTimings:
        return self.__deduction_timing

    def set_deduction_timing(self, value) -> None:
        try:
            self.__deduction_timing = CreditDeductionTimings(int(value))
        except (TypeError, ValueError):
            self.__deduction_timing = CreditDeductionTimings.ON_SUCCESS

    def get_interval_seconds(self) -> float:
        return self.__interval_seconds

    def set_interval_seconds(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = CreditSpendRule.DEFAULT_INTERVAL_SECONDS
        if value <= 0:
            value = CreditSpendRule.DEFAULT_INTERVAL_SECONDS
        self.__interval_seconds = value

    def get_minimum_balance_floor(self):
        # None means unlimited (never blocked); a number is the lowest
        # post-balance this charge may leave behind (0 = no negative).
        return self.__minimum_balance_floor

    def set_minimum_balance_floor(self, value) -> None:
        if value is None or value == "":
            self.__minimum_balance_floor = None
            return
        try:
            self.__minimum_balance_floor = float(value)
        except (TypeError, ValueError):
            self.__minimum_balance_floor = 0

    def get_terms(self) -> list:
        return self.__terms

    def set_terms(self, value) -> None:
        terms = []
        if isinstance(value, list):
            for entry in value:
                terms.append(entry if isinstance(entry, CreditSpendTerm) else CreditSpendTerm.from_json(entry))
        self.__terms = terms

    def evaluate(self, metrics: dict = None) -> float:
        if metrics is None:
            metrics = {}
        total = 0.0
        for term in self.__terms:
            total += term.evaluate(metrics)
        return total

    def to_json(self) -> dict:
        return {
            "enabled": self.get_enabled(),
            "deductionTiming": int(self.get_deduction_timing().value),
            "intervalSeconds": self.get_interval_seconds(),
            "minimumBalanceToRun": self.get_minimum_balance_to_run(),
            "minimumBalanceFloor": self.get_minimum_balance_floor(),
            "terms": [term.to_json() for term in self.get_terms()],
        }

    @classmethod
    def from_json(cls, data: dict) -> "CreditSpendRule":
        data = data or {}
        return cls(
            enabled=data.get("enabled", False),
            deduction_timing=data.get("deductionTiming", CreditDeductionTimings.ON_SUCCESS),
            interval_seconds=data.get("intervalSeconds", CreditSpendRule.DEFAULT_INTERVAL_SECONDS),
            minimum_balance_to_run=data.get("minimumBalanceToRun", 0),
            minimum_balance_floor=data.get("minimumBalanceFloor", 0),
            terms=data.get("terms", []),
        )
