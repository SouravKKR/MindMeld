from enum import IntEnum

class CreditDealPaymentStatuses(IntEnum):
    NONE = 0
    PENDING = 1
    CAPTURED = 2
    RECORDED = 3
    FAILED = 4
    REFUNDED = 5
