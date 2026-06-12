from enum import IntEnum

class CreditTransactionTypes(IntEnum):
    UNKNOWN = 0
    TASK_CHARGE = 1
    STORAGE_CHARGE = 2
    REWARD_GRANT = 3
    ADMIN_ADJUSTMENT = 4
    SIGNUP_GRANT = 5
    REFUND = 6
