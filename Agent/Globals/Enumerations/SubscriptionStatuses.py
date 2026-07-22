from enum import IntEnum

class SubscriptionStatuses(IntEnum):
    CREATED = 0
    AUTHENTICATED = 1
    ACTIVE = 2
    PENDING = 3
    HALTED = 4
    CANCELLED = 5
    COMPLETED = 6
    EXPIRED = 7
