const AdminEmailQueryEngine = require("../../../Globals/Classes/Database/AdminEmailQueryEngine");


/**
 * GET /Admin/AdminEmails
 *
 * Returns every row in the admin-emails allowlist for the Admins tab
 * to render. Order matches the QueryEngine — addedAt ascending — so
 * the seeded founder always sorts first.
 */
async function listAdminEmails(request, response)
{
    try
    {
        const rows = await AdminEmailQueryEngine.listAdmins();
        response.sendJson({ admins: rows });
    }
    catch (loadError)
    {
        console.error(`[ListAdminEmails] ${loadError.message}`);
        response.statusCode = 500;
        response.sendJson({ error: "Failed to load admin emails." });
    }
}

module.exports = { listAdminEmails };
