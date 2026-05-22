from enum import IntEnum

class SessionStates(IntEnum):
    ACTIVE = 0
    STALE_OFFLINE = 1
    REVOKED = 2
