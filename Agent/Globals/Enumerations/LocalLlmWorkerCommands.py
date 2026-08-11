from enum import IntEnum

class LocalLlmWorkerCommands(IntEnum):
    LOAD = 0
    GENERATE = 1
    INTERRUPT = 2
    UNLOAD = 3
