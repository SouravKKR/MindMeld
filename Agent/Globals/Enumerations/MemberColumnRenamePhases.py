from enum import IntEnum

class MemberColumnRenamePhases(IntEnum):
    IDLE = 0
    COPYING = 1
    REPOINTING = 2
    CLEANING = 3
