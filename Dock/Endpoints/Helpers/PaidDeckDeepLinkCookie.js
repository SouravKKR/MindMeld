const App = require("../../Globals/Classes/App");
const PaidDeckShareConstants = require("../../Globals/Constants/PaidDeckShareConstants");

/**
 * PaidDeckDeepLinkCookie
 *
 * Carries a scanned paid-deck share link across the sign-in round trip.
 *
 * A visitor who scans a deck's QR code while signed out lands on the SPA entry
 * route and is handed the login shell. The Google leg of authentication then
 * navigates off-origin and comes back to /Login/Callback, which has no memory of
 * the original URL — so the deck they asked for is stashed here, server-side,
 * and the callback redirects to it instead of the bare origin.
 *
 * The stored value is a DECK ID and nothing else. It is never a URL, and the
 * redirect location is composed here from App.getOrigin(). That is what makes an
 * open redirect structurally impossible rather than something a filter has to
 * catch: an attacker who could write this cookie still cannot express a
 * destination in it.
 */
class PaidDeckDeepLinkCookie
{
    // Paid-deck IDs are crypto.randomUUID() values (see PaidDeck's constructor),
    // so hex and hyphens are the entire alphabet. "//evil.com", "\evil.com",
    // "?", "#", "@", CR and LF are all structurally unrepresentable.
    static DECK_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

    // SameSite=Lax is required, not a preference: the callback arrives as a
    // cross-site top-level GET redirect from accounts.google.com, and Strict
    // would have the browser withhold the cookie exactly then. The existing
    // loginState cookie is Lax for the same reason.
    static COOKIE_OPTIONS =
    {
        maxAge: PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_MAX_AGE_SECONDS,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    };

    static isValidDeckId(candidateDeckId)
    {
        if (typeof candidateDeckId !== "string")
        {
            return false;
        }

        return PaidDeckDeepLinkCookie.DECK_ID_PATTERN.test(candidateDeckId);
    }

    /**
     * Called from the SPA entry handler. A signed-out visitor with a well-formed
     * deck ID gets it stashed; anyone else has any leftover cookie swept away.
     *
     * Signed-in visitors need nothing stashed — the SPA reads the query
     * parameter straight off the URL it was served at — and clearing on that
     * path also disposes of a cookie left behind by an abandoned sign-in.
     */
    static async captureOrClear(request, response, session)
    {
        if (session)
        {
            await PaidDeckDeepLinkCookie.#clearIfPresent(request, response);
            return;
        }

        const queryParameters = await request.getQueryParams();
        const requestedDeckId = queryParameters[PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER] || "";

        if (!PaidDeckDeepLinkCookie.isValidDeckId(requestedDeckId))
        {
            // A malformed ID is simply not stored. Clearing here as well means a
            // second, junk-bearing visit cannot resurrect an older pending deck.
            await PaidDeckDeepLinkCookie.#clearIfPresent(request, response);
            return;
        }

        response.setCookie
        (
            PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME,
            requestedDeckId,
            PaidDeckDeepLinkCookie.COOKIE_OPTIONS
        );
    }

    /**
     * Reads the pending deck ID and consumes it in the same breath — a failed or
     * abandoned sign-in must not leave the next one redirecting somewhere the
     * user never asked for. Returns "" when there is nothing valid to resume.
     *
     * The value is re-validated on read: a cookie is attacker-influenced input
     * and may have been written by an older or looser build.
     */
    static async takePendingDeckId(request, response)
    {
        PaidDeckDeepLinkCookie.clear(response);

        let cookies = {};
        try
        {
            cookies = await request.getCookies();
        }
        catch (cookieReadError)
        {
            // A malformed Cookie header must never break sign-in; it only means
            // there is no deck to resume.
            return "";
        }

        const pendingDeckId = cookies[PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME] || "";

        return PaidDeckDeepLinkCookie.isValidDeckId(pendingDeckId) ? pendingDeckId : "";
    }

    /**
     * Composes the post-login destination. The origin comes from App.getOrigin()
     * — never from the cookie, the query string or the Host header — so the
     * result can only ever point back at this deployment. Returns null when
     * there is no deck to resume, letting the caller fall back to the origin.
     */
    static buildResumeLocation(deckId)
    {
        if (!PaidDeckDeepLinkCookie.isValidDeckId(deckId))
        {
            return null;
        }

        const queryParameterName = PaidDeckShareConstants.DEEP_LINK_DECK_ID_QUERY_PARAMETER;

        return `${App.getOrigin()}${PaidDeckShareConstants.DEEP_LINK_ROUTE_PATH}?${queryParameterName}=${encodeURIComponent(deckId)}`;
    }

    static clear(response)
    {
        response.clearCookie(PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME);
    }

    /**
     * The SPA entry handler serves "/" and "/index.html" as well as the deep
     * link, so an unconditional clear would hang a redundant Set-Cookie header
     * off every single page load. Only emit one when there is actually a
     * pending deck to dispose of.
     */
    static async #clearIfPresent(request, response)
    {
        let cookies = {};
        try
        {
            cookies = await request.getCookies();
        }
        catch (cookieReadError)
        {
            return;
        }

        if (cookies[PaidDeckShareConstants.PENDING_DECK_ID_COOKIE_NAME])
        {
            PaidDeckDeepLinkCookie.clear(response);
        }
    }
}

module.exports = PaidDeckDeepLinkCookie;
