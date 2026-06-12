from enum import IntEnum

class CreditDeductionTimings(IntEnum):
    UNKNOWN = 0
    ON_START = 1
    AT_INTERVALS = 2
    ON_SUCCESS = 3
    ON_ANY_COMPLETION = 4
