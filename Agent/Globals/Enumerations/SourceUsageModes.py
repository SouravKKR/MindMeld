from enum import IntEnum

class SourceUsageModes(IntEnum):
    VERIFICATION_ONLY = 0
    CONTENT_AND_VERIFICATION = 1
    CONTENT_ONLY = 2
