const AllowedLoginEmailQueryEngine = require("../../../Globals/Classes/Database/AllowedLoginEmailQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * GET /Admin/AllowedEmails
 *
 * Returns every row in the login-email allowlist for the Access tab to
 * render. Order matches the QueryEngine — addedAt ascending — so the
 * seeded founder always sorts first.
 */
async function listAllowedEmails(request, response)
{
    try
    {
        const rows = await AllowedLoginEmailQueryEngine.listAllowed();
        response.sendJson({ allowed: rows });
    }
    catch (loadError)
    {
        console.error(`[ListAllowedEmails] ${loadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to load allowed emails." });
    }
}

module.exports = { listAllowedEmails };
