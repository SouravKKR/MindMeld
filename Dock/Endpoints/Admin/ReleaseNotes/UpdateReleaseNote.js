const ReleaseNoteQueryEngine = require("../../../Globals/Classes/Database/ReleaseNoteQueryEngine");


/**
 * POST /Admin/ReleaseNotes/Update
 *
 * Body: { id: string, updates: { title?, contentHtml?, releaseDate? } }
 *
 * Only title / contentHtml / releaseDate may change. Version,
 * versionSortKey, createdAt and createdBy are immutable — editing must
 * never re-notify users (the user's lastSeenReleaseNoteVersionSortKey
 * pointer keys off versionSortKey, which we leave alone). updatedAt is
 * refreshed automatically by the query engine.
 */
async function updateReleaseNote(request, response)
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

    const updates = body?.updates && typeof body.updates === "object" ? body.updates : {};

    try
    {
        const note = await ReleaseNoteQueryEngine.update(noteId, updates);
        if (!note)
        {
            response.statusCode = 404;
            response.sendJson({ error: "Release note not found." });
            return;
        }
        response.sendJson({ ok: true, note });
    }
    catch (updateError)
    {
        console.error(`[UpdateReleaseNote] ${updateError.message}`);
        response.statusCode = 400;
        response.sendJson({ error: updateError.message || "Failed to update release note." });
    }
}

module.exports = { updateReleaseNote };
