from enum import IntEnum

class LocalLlmWorkerCommands(IntEnum):
    LOAD = 0
    GENERATE = 1
    INTERRUPT = 2
    UNLOAD = 3
    HAS_MODEL = 4
    DELETE_MODEL = 5
