from enum import IntEnum

class IntellectualPropertyComplaintStatus(IntEnum):
    RECEIVED = 1
    CONTACT_VERIFIED = 2
    UNDER_REVIEW = 3
    ACCESS_DISABLED = 4
    ACTIONED = 5
    RESTORED = 6
    REJECTED = 7
    WITHDRAWN = 8
