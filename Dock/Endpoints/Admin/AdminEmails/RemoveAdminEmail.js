const AdminEmailQueryEngine = require("../../../Globals/Classes/Database/AdminEmailQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * POST /Admin/AdminEmails/Remove
 *
 * Body: { email: string }
 *
 * Refuses two cases with 409 Conflict so the admin gets a clear,
 * actionable error rather than a silent partial change:
 *   1. SELF_REMOVAL — the email matches the requester's own email.
 *      Demoting yourself in one click would log you out of the panel
 *      mid-action.
 *   2. LAST_ADMIN_PROTECTED — removing this row would empty the
 *      allowlist, locking everybody out on the next login.
 *
 * Both checks are enforced server-side; the UI may also disable the
 * button cosmetically.
 */
async function removeAdminEmail(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Email is required." });
        return;
    }

    const requesterEmail = (requester.getAdditionalData()?.email || "").toLowerCase();
    if (email === requesterEmail)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: "Cannot remove the currently logged-in admin.", reason: ErrorCodes.SELF_REMOVAL });
        return;
    }

    try
    {
        const result = await AdminEmailQueryEngine.removeAdmin(email);
        if (!result.removed)
        {
            if (result.reason === ErrorCodes.LAST_ADMIN_PROTECTED)
            {
                response.statusCode = httpStatus.CONFLICT;
                response.sendJson({ error: "Cannot remove the last admin.", reason: result.reason });
                return;
            }
            if (result.reason === ErrorCodes.NOT_FOUND)
            {
                response.statusCode = httpStatus.NOT_FOUND;
                response.sendJson({ error: "Admin email not found.", reason: result.reason });
                return;
            }
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: "Failed to remove admin.", reason: result.reason });
            return;
        }

        response.sendJson({ ok: true });
    }
    catch (removeError)
    {
        console.error(`[RemoveAdminEmail] ${removeError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: removeError.message || "Failed to remove admin email." });
    }
}

module.exports = { removeAdminEmail };
