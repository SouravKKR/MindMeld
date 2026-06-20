const ReleaseNoteQueryEngine = require("../../../Globals/Classes/Database/ReleaseNoteQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


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

    const noteId = typeof body?.id === "string" ? body.id.trim() : "";
    if (noteId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "id is required." });
        return;
    }

    try
    {
        const result = await ReleaseNoteQueryEngine.deleteById(noteId);
        if (!result.removed)
        {
            if (result.reason === ErrorCodes.NOT_FOUND)
            {
                response.statusCode = httpStatus.NOT_FOUND;
                response.sendJson({ error: "Release note not found.", reason: result.reason });
                return;
            }
            response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
            response.sendJson({ error: "Failed to delete release note.", reason: result.reason });
            return;
        }
        response.sendJson({ ok: true });
    }
    catch (deleteError)
    {
        console.error(`[DeleteReleaseNote] ${deleteError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: deleteError.message || "Failed to delete release note." });
    }
}

module.exports = { deleteReleaseNote };
