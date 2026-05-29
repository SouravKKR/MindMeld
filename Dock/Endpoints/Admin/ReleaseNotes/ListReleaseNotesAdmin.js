const ReleaseNoteQueryEngine = require("../../../Globals/Classes/Database/ReleaseNoteQueryEngine");


/**
 * GET /Admin/ReleaseNotes/List
 *
 * Returns every release note in descending versionSortKey order, with
 * no joinDate filtering. The admin tab is a management surface — the
 * admin must always see the entire archive, even notes published
 * before their own account was created. The user-facing
 * /ReleaseNotes/List endpoint applies the joinDate gate.
 */
async function listReleaseNotesAdmin(request, response)
{
    try
    {
        const notes = await ReleaseNoteQueryEngine.listAll();
        response.sendJson({ notes });
    }
    catch (loadError)
    {
        console.error(`[ListReleaseNotesAdmin] ${loadError.message}`);
        response.statusCode = 500;
        response.sendJson({ error: "Failed to load release notes." });
    }
}

module.exports = { listReleaseNotesAdmin };
