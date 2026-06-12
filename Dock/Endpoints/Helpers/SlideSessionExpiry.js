const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const UserSession = require("../../Globals/Model/UserSession");
const { getSession } = require("./GetSession");

/**
 * Sliding session expiry — the inactivity half of the session-lifetime
 * policy. The Mongo TTL index expires a session at its `expirationDate`;
 * this helper slides that date forward by the full lifetime on each
 * authenticated request, so a session only dies after the user has been
 * inactive for a month (not a fixed month after login).
 *
 * Called from the auth guards (EnsureLogin / EnsureAdmin / EnsureOrgAdmin),
 * which together gate every authenticated endpoint and hold both the
 * request (to resolve the session) and the response (to re-issue the
 * cookie). The persisting write is throttled to at most once per session
 * per UserSession.REFRESH_THROTTLE_MILLISECONDS, so an active user costs a
 * single session write per day rather than one per request.
 *
 * Best-effort: a failed slide is logged and swallowed. The session is
 * still valid for this request — only the expiry extension is skipped —
 * so a transient DB hiccup must never turn a good request into a 5xx.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function slideSessionExpiry(request, response)
{
    // One slide attempt per request — a request only passes through a single
    // guard, but the flag keeps this idempotent if that ever changes.
    if (request.__sessionExpirySlid)
    {
        return;
    }
    request.__sessionExpirySlid = true;

    const session = request.session || await getSession(request);
    if (!session)
    {
        return;
    }

    const millisecondsSinceRefresh = Date.now() - session.getLastRefreshDate().getTime();
    if (millisecondsSinceRefresh < UserSession.REFRESH_THROTTLE_MILLISECONDS)
    {
        return;
    }

    try
    {
        // refresh() recomputes expirationDate = now + lifetime and persists it.
        await AuthenticationQueryEngine.refreshSession(session);
    }
    catch (refreshError)
    {
        console.error(`[SlideSessionExpiry] Failed to refresh session ${session.getId()}: ${refreshError.message}`);
        return;
    }

    // Re-issue the cookie so the browser-side lifetime slides in step with the
    // server-side row — otherwise an actively-used cookie would still be
    // dropped at the fixed login + lifetime mark.
    response.setCookie("sessionId", session.getId(),
    {
        maxAge: Math.floor(UserSession.getExpirationTime() / 1000),
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });
}

module.exports = { slideSessionExpiry };
