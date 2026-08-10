const { PacketronPlugin, PacketronPluginPriority } = require("@gamiumgamers/packetron");
const { getSession } = require("../Helpers/GetSession");
const { getUser } = require("../Helpers/GetUser");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureLegalAcceptance
 *
 * A global plugin (runs before routing, like the rate limiter) that makes
 * Terms-of-Service / Privacy-Policy acceptance a SERVER-ENFORCED precondition
 * for using the app. While an authenticated user still owes acceptance of any
 * current legal document, every protected endpoint returns
 * 403 LEGAL_ACCEPTANCE_REQUIRED — so a non-standard or scripted client cannot
 * obtain functional access without first recording consent through the
 * dedicated /Legal/Accept endpoint. The official client surfaces the same
 * state as the blocking terms modal.
 *
 * Why a global plugin: it must cover EVERY data/mutation endpoint without
 * having to remember to attach a per-route plugin to each one — the same
 * reasoning the rate-limit plugin uses. It runs at VERY_HIGH priority, just
 * below the rate limiter (EXTEMELY_HIGH), so flood control still wins first.
 *
 * Deliberately NOT blocked (so login, identity, the documents themselves and
 * the acceptance write all keep working while pending):
 *   - the SPA shell ("/", "/index.html") and all static assets,
 *   - the login/auth handshake endpoints,
 *   - /GetUser, /Logout, /LegalDocuments, /Legal/Accept.
 *
 * Fail-open: any session/user/document lookup error, or no seeded documents,
 * lets the request through — a DB hiccup must never lock the entire API.
 */

const STATIC_RESOURCE_EXTENSIONS = new Set
([
    "js", "mjs", "css", "map", "json", "wasm", "txt", "html", "htm",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "webm", "wav", "ogg", "bin", "data", "pdf", "csv"
]);

// Lower-cased, query-stripped paths that must stay reachable while a session
// is in the legal-acceptance-pending state.
const ALLOWLISTED_PATHS = new Set
([
    "/",
    "/index.html",
    "/login",
    "/login/callback",
    "/auth/requestotp",
    "/auth/verifyotp",
    "/logout",
    "/getuser",
    "/legaldocuments",
    "/legal/accept",
    // The infringement-complaint channel. These are unauthenticated routes, so
    // the anonymous path below already lets them through — but a signed-in user
    // who owes acceptance would otherwise be 403'd out of reporting that their
    // own work is on the platform, which is exactly backwards: the version bump
    // that put them in the pending state is the one that ADDED this channel.
    // Nothing here reads or writes user data, so there is nothing to withhold.
    "/legal/intellectualpropertycomplaint",
    "/legal/intellectualpropertycomplaint/verify",
    "/legal/intellectualpropertycomplaint/evidence",
    // The unauthenticated account-access report, for the same reason and one
    // more: the reporter may be blocked precisely because they cannot get far
    // enough into the app to accept anything.
    "/support/report/submitpublic",
    // The public /copyright landing page is an SPA SHELL entry like "/" and
    // carries no file extension, so isStaticResourcePath() does not cover it.
    "/copyright",
    // The paid-deck QR deep link is an SPA SHELL entry, exactly like "/" — but it
    // carries no file extension, so isStaticResourcePath() does not cover it. A
    // user who owes acceptance and follows a scanned link is precisely the case
    // this feature exists for; without this entry they would receive a raw
    // 403 LEGAL_ACCEPTANCE_REQUIRED JSON body in the address bar instead of the
    // app (which then shows the blocking terms modal itself).
    "/paiddeck",
    // The storefront listing read behind that shell is public and exposes no user
    // data, so the deep link can resolve while the terms modal is still up.
    "/paiddecks/details",
    // A browser posts CSP violation reports with no app context and carries the
    // session cookie along automatically. 403-ing them would blind the strict-
    // policy rollout for exactly the users who have not accepted yet.
    "/security/cspreport"
]);

function getEndpointPath(request)
{
    const rawUrl = typeof request.url === "string" ? request.url : "";
    return rawUrl.split("?")[0] || "/";
}

function isStaticResourcePath(endpointPath)
{
    const normalized = endpointPath.replace(/^\/+/, "").toLowerCase();

    if (normalized === "")
    {
        return true;
    }

    if (normalized.startsWith("assets/"))
    {
        return true;
    }

    const lastSegment = normalized.substring(normalized.lastIndexOf("/") + 1);
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex === -1)
    {
        return false;
    }

    const extension = lastSegment.substring(dotIndex + 1);
    return STATIC_RESOURCE_EXTENSIONS.has(extension);
}

const legalAcceptancePlugin = new PacketronPlugin
({
    priority: PacketronPluginPriority.VERY_HIGH,
    handler: async (request, response) =>
    {
        const endpointPath = getEndpointPath(request);
        const normalizedPath = endpointPath.toLowerCase();

        if (ALLOWLISTED_PATHS.has(normalizedPath) || isStaticResourcePath(endpointPath))
        {
            return false;
        }

        let user = null;
        try
        {
            const session = await getSession(request);
            if (!session)
            {
                // Anonymous request — EnsureLogin (or the handler) issues the 401.
                return false;
            }
            user = await getUser(request);
        }
        catch (lookupError)
        {
            return false;
        }

        if (!user)
        {
            return false;
        }

        let pendingDocuments = [];
        try
        {
            pendingDocuments = await LegalAcceptanceService.getPendingDocuments(user);
        }
        catch (pendingLookupError)
        {
            return false;
        }

        if (pendingDocuments.length === 0)
        {
            return false;
        }

        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.LEGAL_ACCEPTANCE_REQUIRED, documents: pendingDocuments });
        return true;
    }
});

module.exports = { legalAcceptancePlugin };
