from enum import IntEnum

class CuratedBatchReviewStates(IntEnum):
    LIVE = 0
    PENDING_REVIEW = 1
    ARCHIVED = 2
