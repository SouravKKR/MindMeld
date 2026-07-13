from enum import IntEnum

class StorageTargets(IntEnum):
    LOCAL_FILE_SYSTEM = 1
    GOOGLE_CLOUD_STORAGE = 2
    LINODE_OBJECT_STORAGE = 3
