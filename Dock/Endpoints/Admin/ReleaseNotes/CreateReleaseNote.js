const ReleaseNoteQueryEngine = require("../../../Globals/Classes/Database/ReleaseNoteQueryEngine");
const { semVerBumpTypes } = require("../../../Globals/Enumerations/SemVerBumpTypes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");


/**
 * POST /Admin/ReleaseNotes/Create
 *
 * Body: { title: string, contentHtml: string, bumpType: semVerBumpTypes }
 *
 * The server computes the next semver — the client only chooses the
 * bump type. First-ever release is always 1.0.0 regardless of bumpType.
 * Release date / created / updated timestamps are all stamped to the
 * current time; the admin can edit releaseDate later via Update.
 */
async function createReleaseNote(request, response)
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
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const contentHtml = typeof body?.contentHtml === "string" ? body.contentHtml : "";
    const bumpType = Number(body?.bumpType);
    const test = body?.test === true;

    if (title.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Title is required." });
        return;
    }

    if (title.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Title must be at most 256 characters." });
        return;
    }

    if (contentHtml.length > 200000)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Content exceeds 200000 characters." });
        return;
    }

    const allowedBumpValues = Object.values(semVerBumpTypes);
    if (!allowedBumpValues.includes(bumpType))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Invalid bump type." });
        return;
    }

    try
    {
        const note = await ReleaseNoteQueryEngine.create(title, contentHtml, bumpType, requester.getId(), test);
        response.sendJson({ ok: true, note });
    }
    catch (createError)
    {
        console.error(`[CreateReleaseNote] ${createError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: createError.message || "Failed to create release note." });
    }
}

module.exports = { createReleaseNote };
