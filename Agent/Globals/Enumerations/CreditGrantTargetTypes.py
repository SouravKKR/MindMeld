from enum import IntEnum

class CreditGrantTargetTypes(IntEnum):
    UNKNOWN = 0
    USER_EMAILS = 1
    USER_FILTER = 2
    ORGANIZATION = 3
