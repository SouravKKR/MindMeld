from enum import IntEnum

class TaskStatus(IntEnum):
    UNKNOWN = 0
    NOT_STARTED = 1
    IN_PROGRESS = 2
    COMPLETED = 3
    FAILED = 4
