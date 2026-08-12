const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const AgeVerificationService = require("../../Globals/Classes/Authentication/AgeVerificationService");
const CreditLedger = require("../../Globals/Classes/Credits/CreditLedger");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const MetricBadgeManager = require("../../Globals/Classes/Metrics/MetricBadgeManager");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * Endpoint: POST /UpdateUserAdditionalData
 *
 * Body: { partialAdditionalData: { ...fieldsToMerge } }
 *
 * Updates the authenticated user's additionalData by merging the supplied
 * partial object on a per-field basis. Returns the resulting additionalData
 * so the client can sync its in-memory User without a follow-up GetUser.
 *
 * Reserved consent fields (agreed<Doc>Version / agreed<Doc>At) are stripped
 * here: legal acceptance is recorded ONLY through the dedicated, server-
 * validated /Legal/Accept endpoint, so a client cannot self-assert agreement
 * to a version it never saw through this generic merge.
 */
async function handleUpdateUserAdditionalData(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const partialAdditionalData = body?.partialAdditionalData;

    if (!partialAdditionalData || typeof partialAdditionalData !== "object")
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    // Strip reserved fields the client may never write through this generic
    // merge: consent fields (only /Legal/Accept may set these) and the
    // credit-owned fields (balance / spend history / billing baseline are
    // mutated solely by CreditLedger and the storage assessor server-side).
    const sanitizedAdditionalData = {};
    for (const fieldKey of Object.keys(partialAdditionalData))
    {
        if (LegalAcceptanceService.isReservedConsentKey(fieldKey))
        {
            continue;
        }
        // Age and guardian-consent state is written only by the /Age endpoints,
        // which derive it server-side. A client that could merge its own
        // declaredAgeYears or guardianConsent through here would be able to
        // declare itself an adult, or consent on its own guardian's behalf, and
        // the gate would be decorative.
        if (AgeVerificationService.isReservedAgeKey(fieldKey))
        {
            continue;
        }
        if (CreditLedger.isLedgerOwnedAdditionalDataKey(fieldKey))
        {
            continue;
        }
        // Streak / badge state is awarded server-side only — a client must not
        // be able to set its own streak length or grant itself badges.
        if (StreakManager.isStreakOwnedAdditionalDataKey(fieldKey))
        {
            continue;
        }
        // Achievement metric counters / milestone badges are server-owned too
        // (mutated only via /Metrics/Report with its clamp + rate limit).
        if (MetricBadgeManager.isMetricOwnedAdditionalDataKey(fieldKey))
        {
            continue;
        }
        sanitizedAdditionalData[fieldKey] = partialAdditionalData[fieldKey];
    }

    if (Object.keys(sanitizedAdditionalData).length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.NO_WRITABLE_FIELDS });
        return;
    }

    const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(user.getId(), sanitizedAdditionalData);

    if (!updatedAdditionalData)
    {
        response.sendStatusCode(httpStatus.INTERNAL_SERVER_ERROR);
        return;
    }

    response.sendJson({ additionalData: updatedAdditionalData });
}

module.exports = { handleUpdateUserAdditionalData };
