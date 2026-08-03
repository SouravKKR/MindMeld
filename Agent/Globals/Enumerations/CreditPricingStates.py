from enum import IntEnum

class CreditPricingStates(IntEnum):
    PRICED = 0
    UNPRICED = 1
    DENIED = 2
    FREE = 3
