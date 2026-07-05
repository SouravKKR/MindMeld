const AllowedLoginEmailQueryEngine = require("../../../Globals/Classes/Database/AllowedLoginEmailQueryEngine");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * POST /Admin/AllowedEmails/Remove
 *
 * Body: { email: string }
 *
 * Removes an email from the login allowlist. Unlike the admin allowlist
 * there is no self-removal or last-record guard — emptying the list is a
 * valid state that leaves only the env / admin emails allowed.
 */
async function removeAllowedEmail(request, response)
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

    try
    {
        const result = await AllowedLoginEmailQueryEngine.removeAllowed(email);
        if (!result.removed)
        {
            if (result.reason === ErrorCodes.NOT_FOUND)
            {
                response.statusCode = httpStatus.NOT_FOUND;
                response.sendJson({ error: "Allowed email not found.", reason: result.reason });
                return;
            }
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: "Failed to remove allowed email.", reason: result.reason });
            return;
        }

        response.sendJson({ ok: true });
    }
    catch (removeError)
    {
        console.error(`[RemoveAllowedEmail] ${removeError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: removeError.message || "Failed to remove allowed email." });
    }
}

module.exports = { removeAllowedEmail };
