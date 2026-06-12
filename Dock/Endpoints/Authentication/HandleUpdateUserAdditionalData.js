const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const CreditLedger = require("../../Globals/Classes/Credits/CreditLedger");
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
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const partialAdditionalData = body?.partialAdditionalData;

    if (!partialAdditionalData || typeof partialAdditionalData !== "object")
    {
        response.sendStatusCode(400);
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
        if (CreditLedger.isLedgerOwnedAdditionalDataKey(fieldKey))
        {
            continue;
        }
        sanitizedAdditionalData[fieldKey] = partialAdditionalData[fieldKey];
    }

    if (Object.keys(sanitizedAdditionalData).length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "NO_WRITABLE_FIELDS" });
        return;
    }

    const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(user.getId(), sanitizedAdditionalData);

    if (!updatedAdditionalData)
    {
        response.sendStatusCode(500);
        return;
    }

    response.sendJson({ additionalData: updatedAdditionalData });
}

module.exports = { handleUpdateUserAdditionalData };
