# Fixed set of log-entry titles used across the Agent, mirroring the Dock and Web
# LogTitles so the <Title> in the canonical line format is consistent everywhere.
# Ad-hoc titles are still permitted for genuinely one-off entries.


class LogTitles:

    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    LOGIN_REJECTED = "LOGIN_REJECTED"
    AI_ASK = "AI_ASK"
    AI_GENERATION = "AI_GENERATION"
    PURCHASE_CREDITS = "PURCHASE_CREDITS"
    PURCHASE_DECK = "PURCHASE_DECK"
    PURCHASE_ORGANIZATION = "PURCHASE_ORGANIZATION"
    PURCHASE_DEAL = "PURCHASE_DEAL"
    REQUEST_COMPLETED = "REQUEST_COMPLETED"
    REQUEST_ERROR = "REQUEST_ERROR"
    SERVER_EVENT = "SERVER_EVENT"
    LOG_ARCHIVAL = "LOG_ARCHIVAL"
