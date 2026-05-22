from enum import IntEnum

class PurchaseStatuses(IntEnum):
    PENDING = 0
    COMPLETED = 1
    REFUNDED = 2
    FAILED = 3
