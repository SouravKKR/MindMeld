/**
 * LogTitles (browser) — mirrors the Dock and Agent LogTitles so the <Title> in the
 * canonical format is consistent everywhere, plus the client-only titles for the
 * captured window errors.
 */
class LogTitles
{
    static LOGIN = "LOGIN";
    static LOGOUT = "LOGOUT";
    static AI_ASK = "AI_ASK";
    static AI_GENERATION = "AI_GENERATION";
    static CONTENT_GUARDRAIL = "CONTENT_GUARDRAIL";
    static PURCHASE_CREDITS = "PURCHASE_CREDITS";
    static PURCHASE_DECK = "PURCHASE_DECK";
    static CLIENT_ERROR = "CLIENT_ERROR";
    static CLIENT_UNHANDLED_REJECTION = "CLIENT_UNHANDLED_REJECTION";
    static CLIENT_EVENT = "CLIENT_EVENT";
}

export default LogTitles;
