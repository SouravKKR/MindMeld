const ReleaseNoteQueryEngine = require("../../../Globals/Classes/Database/ReleaseNoteQueryEngine");


/**
 * POST /Admin/ReleaseNotes/Delete
 *
 * Body: { id: string }
 *
 * Deleting a note that some users have already passed is harmless —
 * their lastSeenReleaseNoteVersionSortKey is already at or above its
 * sort key, so nothing changes for them. Deleting one users haven't
 * seen quietly drops it from their popup queue, which the admin has
 * implicitly accepted by choosing to delete.
 */
async function deleteReleaseNote(request, response)
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

    const noteId = typeof body?.id === "string" ? body.id.trim() : "";
    if (noteId.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ error: "id is required." });
        return;
    }

    try
    {
        const result = await ReleaseNoteQueryEngine.deleteById(noteId);
        if (!result.removed)
        {
            if (result.reason === "NOT_FOUND")
            {
                response.statusCode = 404;
                response.sendJson({ error: "Release note not found.", reason: result.reason });
                return;
            }
            response.statusCode = 500;
            response.sendJson({ error: "Failed to delete release note.", reason: result.reason });
            return;
        }
        response.sendJson({ ok: true });
    }
    catch (deleteError)
    {
        console.error(`[DeleteReleaseNote] ${deleteError.message}`);
        response.statusCode = 500;
        response.sendJson({ error: deleteError.message || "Failed to delete release note." });
    }
}

module.exports = { deleteReleaseNote };
