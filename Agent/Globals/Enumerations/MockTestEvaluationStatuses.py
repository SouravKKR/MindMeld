from enum import IntEnum

class MockTestEvaluationStatuses(IntEnum):
    PENDING = 0
    GRADING = 1
    COMPLETED = 2
    FAILED = 3
