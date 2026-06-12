# Mirror of Dock/Globals/Classes/Credits/CreditConfiguration.js. The single
# global credit configuration the admin edits. `task_rules` is keyed by
# TaskTypes name; `storage_rules` by CreditChargeCategories name.

from datetime import datetime

from Globals.Enumerations.TaskTypes import TaskTypes
from Globals.Enumerations.CreditChargeCategories import CreditChargeCategories
from Globals.Enumerations.CreditEnforcementModes import CreditEnforcementModes
from Globals.Classes.Credits.CreditSpendRule import CreditSpendRule
from Globals.Classes.Credits.CreditRewardMilestone import CreditRewardMilestone


class CreditConfiguration:

    DEFAULT_SIGNUP_GRANT = 5

    def __init__(self, task_rules: dict = None, storage_rules: dict = None, reward_milestones: list = None, default_enforcement_mode: CreditEnforcementModes = CreditEnforcementModes.ALLOW_NEGATIVE, signup_grant: float = None, version: int = 1, updated_at=None, updated_by: str = "") -> None:
        self.set_task_rules(task_rules if task_rules is not None else {})
        self.set_storage_rules(storage_rules if storage_rules is not None else {})
        self.set_reward_milestones(reward_milestones if reward_milestones is not None else [])
        self.set_default_enforcement_mode(default_enforcement_mode)
        self.set_signup_grant(signup_grant if signup_grant is not None else CreditConfiguration.DEFAULT_SIGNUP_GRANT)
        self.set_version(version)
        self.set_updated_at(updated_at)
        self.set_updated_by(updated_by)

    def set_task_rules(self, value) -> None:
        rules = {}
        if isinstance(value, dict):
            for task_type_name in value:
                entry = value[task_type_name]
                rules[task_type_name] = entry if isinstance(entry, CreditSpendRule) else CreditSpendRule.from_json(entry)
        self.__task_rules = rules

    def get_task_rules(self) -> dict:
        return self.__task_rules

    def set_storage_rules(self, value) -> None:
        rules = {}
        if isinstance(value, dict):
            for category_name in value:
                entry = value[category_name]
                rules[category_name] = entry if isinstance(entry, CreditSpendRule) else CreditSpendRule.from_json(entry)
        self.__storage_rules = rules

    def get_storage_rules(self) -> dict:
        return self.__storage_rules

    def set_reward_milestones(self, value) -> None:
        milestones = []
        if isinstance(value, list):
            for entry in value:
                milestones.append(entry if isinstance(entry, CreditRewardMilestone) else CreditRewardMilestone.from_json(entry))
        milestones.sort(key=lambda milestone: milestone.get_spend_threshold())
        self.__reward_milestones = milestones

    def get_reward_milestones(self) -> list:
        return self.__reward_milestones

    def set_default_enforcement_mode(self, value) -> None:
        try:
            self.__default_enforcement_mode = CreditEnforcementModes(int(value))
        except (TypeError, ValueError):
            self.__default_enforcement_mode = CreditEnforcementModes.ALLOW_NEGATIVE

    def get_default_enforcement_mode(self) -> CreditEnforcementModes:
        return self.__default_enforcement_mode

    def set_signup_grant(self, value) -> None:
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = 0
        if value < 0:
            value = 0
        self.__signup_grant = value

    def get_signup_grant(self) -> float:
        return self.__signup_grant

    def set_version(self, value) -> None:
        try:
            value = int(value)
        except (TypeError, ValueError):
            value = 1
        if value < 1:
            value = 1
        self.__version = value

    def get_version(self) -> int:
        return self.__version

    def set_updated_at(self, value) -> None:
        if value is None:
            self.__updated_at = None
        elif isinstance(value, datetime):
            self.__updated_at = value
        else:
            try:
                self.__updated_at = datetime.fromisoformat(value)
            except (TypeError, ValueError):
                self.__updated_at = None

    def get_updated_at(self):
        return self.__updated_at

    def set_updated_by(self, value) -> None:
        self.__updated_by = str(value) if value is not None else ""

    def get_updated_by(self) -> str:
        return self.__updated_by

    def get_rule_for_task(self, task_type_value):
        """
        Resolves the CONFIGURED spend rule for a TaskTypes value, or None only
        when no rule exists. The rule is returned even when disabled — the
        caller distinguishes absent (unconfigured) from present-but-disabled
        (denied) via rule.get_enabled().
        """
        try:
            task_type_name = TaskTypes(int(task_type_value)).name
        except (TypeError, ValueError):
            return None
        return self.__task_rules.get(task_type_name)

    def get_storage_rule(self, category_value):
        """Resolves the CONFIGURED spend rule for a CreditChargeCategories value, or None."""
        try:
            category_name = CreditChargeCategories(int(category_value)).name
        except (TypeError, ValueError):
            return None
        return self.__storage_rules.get(category_name)

    def to_json(self) -> dict:
        return {
            "taskRules": {name: rule.to_json() for name, rule in self.__task_rules.items()},
            "storageRules": {name: rule.to_json() for name, rule in self.__storage_rules.items()},
            "rewardMilestones": [milestone.to_json() for milestone in self.__reward_milestones],
            "defaultEnforcementMode": int(self.get_default_enforcement_mode().value),
            "signupGrant": self.get_signup_grant(),
            "version": self.get_version(),
            "updatedAt": self.get_updated_at().isoformat() if self.get_updated_at() is not None else None,
            "updatedBy": self.get_updated_by(),
        }

    @classmethod
    def from_json(cls, data: dict) -> "CreditConfiguration":
        data = data or {}
        return cls(
            task_rules=data.get("taskRules", {}),
            storage_rules=data.get("storageRules", {}),
            reward_milestones=data.get("rewardMilestones", []),
            default_enforcement_mode=data.get("defaultEnforcementMode", CreditEnforcementModes.ALLOW_NEGATIVE),
            signup_grant=data.get("signupGrant", CreditConfiguration.DEFAULT_SIGNUP_GRANT),
            version=data.get("version", 1),
            updated_at=data.get("updatedAt"),
            updated_by=data.get("updatedBy", ""),
        )
