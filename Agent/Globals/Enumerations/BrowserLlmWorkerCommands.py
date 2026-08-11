from enum import IntEnum

class BrowserLlmWorkerCommands(IntEnum):
    LOAD = 0
    GENERATE = 1
    INTERRUPT = 2
    UNLOAD = 3
