from enum import IntEnum

class BrowserLlmDownloadStates(IntEnum):
    UNSUPPORTED = 0
    NOT_STARTED = 1
    DOWNLOADING = 2
    READY = 3
    DECLINED = 4
    FAILED = 5
