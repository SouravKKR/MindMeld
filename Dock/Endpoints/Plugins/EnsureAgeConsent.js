const { PacketronPlugin, PacketronPluginPriority } = require("@gamiumgamers/packetron");
const { getSession } = require("../Helpers/GetSession");
const { getUser } = require("../Helpers/GetUser");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { ageConsentStates } = require("../../Globals/Enumerations/AgeConsentStates");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * EnsureAgeConsent
 *
 * A global plugin that makes age declaration — and, for a Child, guardian
 * consent — a SERVER-ENFORCED precondition for processing an account's data.
 * While an authenticated user still owes either, every protected endpoint
 * returns 403 AGE_CONSENT_REQUIRED and the official client surfaces the
 * blocking dialog.
 *
 * Why it is server-enforced rather than a signup screen. A screen the client
 * draws is a screen a non-standard client can skip, and the obligation is on
 * the platform for every account it processes — not only for accounts that
 * happened to sign up after the screen shipped. Existing accounts have no date
 * of birth on file, so they land in UNDECLARED and are prompted on their next
 * request, which is the intended behaviour rather than an upgrade edge case.
 *
 * Ordering. This runs at HIGH priority, immediately BELOW EnsureLegalAcceptance
 * (VERY_HIGH), which itself sits below the rate limiter. The order is
 * deliberate: a user must be able to read the Privacy Policy that explains why
 * a date of birth is being requested before being asked for it, so the terms
 * gate has to clear first.
 *
 * Deliberately NOT blocked, so the user can always reach the flow that unblocks
 * them: the SPA shell and static assets, the login handshake, /GetUser,
 * /Logout, the legal documents and acceptance endpoints (which are gated ahead
 * of this one anyway), and the age endpoints themselves — including BOTH
 * guardian-consent stages, since an account in MINOR_AWAITING_GUARDIAN_CONSENT
 * is blocked precisely while it needs to reach them.
 *
 * Fail-open on lookup errors, matching EnsureLegalAcceptance: a database hiccup
 * must never lock the entire API. It does NOT fail open on an unresolved state
 * — an account with no date of birth is blocked, because that is the whole
 * point of the gate.
 */

const STATIC_RESOURCE_EXTENSIONS = new Set
([
    "js", "mjs", "css", "map", "json", "wasm", "txt", "html", "htm",
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
    "woff", "woff2", "ttf", "otf", "eot",
    "mp3", "mp4", "webm", "wav", "ogg", "bin", "data", "pdf", "csv"
]);

// Lower-cased, query-stripped paths that stay reachable while an account is in
// the age-pending state. Mirrors EnsureLegalAcceptance's allowlist and adds the
// two endpoints that resolve this gate.
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
    "/age/state",
    "/age/declareage",
    "/age/guardianconsent/requestcode",
    "/age/guardianconsent/verify",
    // The infringement-complaint channel and the public account-access report.
    // Same reasoning as in EnsureLegalAcceptance: they are unauthenticated
    // routes that read and write no user data, and a rightsholder must not be
    // kept from filing a notice by a gate about somebody else's account.
    "/legal/intellectualpropertycomplaint",
    "/legal/intellectualpropertycomplaint/verify",
    "/legal/intellectualpropertycomplaint/evidence",
    "/support/report/submitpublic",
    "/copyright",
    "/paiddeck",
    "/paiddecks/details",
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

const ageConsentPlugin = new PacketronPlugin
({
    priority: PacketronPluginPriority.HIGH,
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

        const consentState = AgeVerificationService.resolveState(user);

        if (consentState.bProcessingAllowed)
        {
            return false;
        }

        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson
        ({
            error: ErrorCodes.AGE_CONSENT_REQUIRED,
            // The client needs to know WHICH step is owed so it can open the
            // date-of-birth prompt or the guardian form directly, rather than
            // re-asking for a date of birth the server already holds.
            reason: consentState.state === ageConsentStates.UNDECLARED
                ? ErrorCodes.AGE_DECLARATION_REQUIRED
                : ErrorCodes.GUARDIAN_CONSENT_REQUIRED,
            state: consentState.state
        });
        return true;
    }
});

module.exports = { ageConsentPlugin };
