from enum import IntEnum

class PeriodicOnJoinModes(IntEnum):
    PERIODIC_ONLY = 0
    ON_JOIN_PLUS_PERIODIC = 1
    ON_JOIN_PLUS_PERIODIC_SKIP_FIRST = 2
