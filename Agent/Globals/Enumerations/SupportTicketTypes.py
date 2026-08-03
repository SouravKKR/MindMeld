from enum import IntEnum

class SupportTicketTypes(IntEnum):
    UNKNOWN = 0
    BUG = 1
    GENERATION_QUALITY = 2
    BILLING = 3
    SYNC = 4
    DATA_LOSS = 5
    ACCOUNT_ACCESS = 6
    PERFORMANCE = 7
    USER_INTERFACE = 8
    CONTENT_ERROR = 9
    FEATURE_REQUEST = 10
    OTHER = 11
