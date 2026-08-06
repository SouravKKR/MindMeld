from enum import IntEnum

class OrganizationDelegatePowers(IntEnum):
    NONE = 0
    MANAGE_MEMBERS = 1
    DISTRIBUTE_CREDITS = 2
    SET_PERMISSIONS = 4
    PUBLISH_DECKS = 8
