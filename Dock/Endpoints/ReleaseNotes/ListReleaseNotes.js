const ReleaseNoteQueryEngine = require("../../Globals/Classes/Database/ReleaseNoteQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /ReleaseNotes/List
 * GET /ReleaseNotes/List?majorVersion=2
 *
 * Returns the release notes belonging to a single major version (the
 * current/highest by default), in descending versionSortKey order, plus
 * metadata describing every major version the requester is allowed to
 * see. The frontend uses this to:
 *
 *   - Auto-popup: ignore the metadata, just filter the returned notes
 *     to those above the user's lastSeenReleaseNoteVersionSortKey.
 *   - Sidebar: render a dropdown of `availableMajorVersions` and
 *     re-fetch with `?majorVersion=N` when the user picks a different
 *     release line.
 *
 * Notes flagged `test: true` are hidden from non-admin requesters but
 * served to admins, so the same user-facing popup / sidebar surfaces
 * are usable for QA before flipping the flag to release. The admin
 * tab calls /Admin/ReleaseNotes/List directly without either filter
 * to keep the management surface complete.
 *
 * Sorting authority lives here — the client must not re-sort.
 */
async function listReleaseNotes(request, response)
{
    try
    {
        const requester = await getUser(request);
        if (!requester)
        {
            response.sendStatusCode(httpStatus.UNAUTHORIZED);
            return;
        }

        const includeTest = requester.getRole() === userRoles.ADMIN;

        const availableMajorVersions = await ReleaseNoteQueryEngine.listMajorVersions({ includeTest });

        if (availableMajorVersions.length === 0)
        {
            response.sendJson({
                notes: [],
                selectedMajorVersion: null,
                currentMajorVersion: null,
                availableMajorVersions: []
            });
            return;
        }

        const currentMajorVersion = availableMajorVersions[0];

        const queryParams = await request.getQueryParams();
        const rawMajor = queryParams?.majorVersion;
        const requestedMajor = rawMajor !== undefined && rawMajor !== null ? Number(rawMajor) : Number.NaN;
        const selectedMajorVersion = (Number.isFinite(requestedMajor) && availableMajorVersions.includes(requestedMajor))
            ? requestedMajor
            : currentMajorVersion;

        const notes = await ReleaseNoteQueryEngine.listAll({
            majorVersion: selectedMajorVersion,
            includeTest
        });

        response.sendJson({
            notes,
            selectedMajorVersion,
            currentMajorVersion,
            availableMajorVersions
        });
    }
    catch (loadError)
    {
        console.error(`[ListReleaseNotes] ${loadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to load release notes." });
    }
}

module.exports = { listReleaseNotes };
