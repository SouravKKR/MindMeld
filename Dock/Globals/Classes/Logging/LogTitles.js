/**
 * LogTitles — the fixed set of log-entry titles used across Dock, so call sites
 * pass a named constant (the <Title> in the canonical line format) instead of a
 * free magic string. Ad-hoc titles are still permitted where a title is genuinely
 * one-off, but every recurring event has a constant here.
 */
class LogTitles
{
    static LOGIN = "LOGIN";
    static LOGOUT = "LOGOUT";
    static LOGIN_REJECTED = "LOGIN_REJECTED";
    static AI_ASK = "AI_ASK";
    static AI_GENERATION = "AI_GENERATION";
    static PURCHASE_CREDITS = "PURCHASE_CREDITS";
    static PURCHASE_DECK = "PURCHASE_DECK";
    static PURCHASE_ORGANIZATION = "PURCHASE_ORGANIZATION";
    static PURCHASE_DEAL = "PURCHASE_DEAL";
    static REQUEST_COMPLETED = "REQUEST_COMPLETED";
    static REQUEST_ERROR = "REQUEST_ERROR";
    static SERVER_EVENT = "SERVER_EVENT";
    static LOG_ARCHIVAL = "LOG_ARCHIVAL";
}

module.exports = LogTitles;
