from enum import IntEnum

class LocalLlmWorkerEvents(IntEnum):
    LOAD_PROGRESS = 0
    LOAD_COMPLETE = 1
    TOKEN = 2
    GENERATION_COMPLETE = 3
    FAILED = 4
