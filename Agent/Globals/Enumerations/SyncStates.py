from enum import IntEnum

class SyncStates(IntEnum):
    IDLE = 0
    SYNCING = 1
    STALE = 2
    ERROR = 3
