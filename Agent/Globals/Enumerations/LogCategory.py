from enum import IntEnum

class LogCategory(IntEnum):
    SYSTEM = 0
    AUTHENTICATION = 1
    AI_REQUEST = 2
    PURCHASE = 3
    EVENT = 4
    ERROR = 5
