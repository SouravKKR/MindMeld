from enum import IntEnum

class SupportTicketReportStatus(IntEnum):
    PENDING_GROUPING = 0
    GROUPED = 1
    GROUPING_FAILED = 2
