from enum import IntEnum

class AgeConsentStates(IntEnum):
    UNDECLARED = 0
    ADULT = 1
    MINOR_AWAITING_GUARDIAN_CONSENT = 2
    MINOR_CONSENTED = 3
