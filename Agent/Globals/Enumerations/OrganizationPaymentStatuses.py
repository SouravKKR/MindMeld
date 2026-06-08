from enum import IntEnum

class OrganizationPaymentStatuses(IntEnum):
    PENDING = 0
    CAPTURED = 1
    FAILED = 2
    REFUNDED = 3
