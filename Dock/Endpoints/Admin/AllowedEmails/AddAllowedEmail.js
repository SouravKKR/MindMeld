const AllowedLoginEmailQueryEngine = require("../../../Globals/Classes/Database/AllowedLoginEmailQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * POST /Admin/AllowedEmails/Add
 *
 * Body: { email: string, notes?: string }
 *
 * Idempotent — re-adding an existing email is a no-op apart from
 * refreshing the notes column. Adding an email only permits login for
 * that address when the environment allowlist is enabled; it never
 * grants the ADMIN role.
 */
async function addAllowedEmail(request, response)
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

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";

    if (email.length === 0 || email.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Invalid email." });
        return;
    }

    try
    {
        const result = await AllowedLoginEmailQueryEngine.addAllowed(email, requester.getId(), notes);
        response.sendJson({ ok: true, inserted: result.inserted });
    }
    catch (addError)
    {
        console.error(`[AddAllowedEmail] ${addError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: addError.message || "Failed to add allowed email." });
    }
}

module.exports = { addAllowedEmail };
