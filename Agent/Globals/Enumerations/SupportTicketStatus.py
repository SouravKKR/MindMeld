from enum import IntEnum

class SupportTicketStatus(IntEnum):
    UNKNOWN = 0
    ACTIVE = 1
    RESOLVED = 2
    DECLINED = 3
