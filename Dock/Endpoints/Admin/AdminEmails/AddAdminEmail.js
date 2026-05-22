const AdminEmailQueryEngine = require("../../../Globals/Classes/Database/AdminEmailQueryEngine");


/**
 * POST /Admin/AdminEmails
 *
 * Body: { email: string, notes?: string }
 *
 * Idempotent — re-adding an existing email is a no-op apart from
 * refreshing the notes column. The target user is promoted to ADMIN
 * on their *next* login, not retroactively, because role is stamped
 * onto the User document in HandleLoginCallback.
 */
async function addAdminEmail(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(401);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = 400;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const notes = typeof body?.notes === "string" ? body.notes.trim() : "";

    if (email.length === 0 || email.indexOf("@") < 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "Invalid email." });
        return;
    }

    try
    {
        const result = await AdminEmailQueryEngine.addAdmin(email, requester.getId(), notes);
        response.sendJson({ ok: true, inserted: result.inserted });
    }
    catch (addError)
    {
        console.error(`[AddAdminEmail] ${addError.message}`);
        response.statusCode = 500;
        response.sendJson({ error: addError.message || "Failed to add admin email." });
    }
}

module.exports = { addAdminEmail };
