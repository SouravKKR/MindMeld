const path = require("path");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const PaidDeckVerificationSourceQueryEngine = require("../../../Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Admin/PaidDecks/VerificationSource?verificationSourceId=...
 *
 * Streams back a document a paid deck was checked against, or written from.
 *
 * This is the other half of the licence declaration, and the half that makes the
 * rest of it worth keeping. Recording "this deck's content was written from a
 * document we licensed" is an assertion; it only becomes evidence while the
 * document behind it can still be produced on the day someone asks. The
 * declaration log holds the bytes against deletion — see
 * SourceLicenceDeclarationQueryEngine.findReferencedSourceHashesForUser — and
 * this endpoint is how they are reached.
 *
 * THE STORAGE PATH IS NEVER TAKEN FROM THE REQUEST. The caller names a
 * verification source; the path is rebuilt here from the information-source row
 * that source records. Following DownloadRefinementProofSource and
 * DownloadSupportAttachment: a request that could name a path is a request that
 * could name any path.
 *
 * DETACHED SOURCES ARE STILL SERVED. A source detached after a deck was written
 * from it is still what that deck was written from, and refusing to produce it
 * would make the record unfalsifiable in the one direction that matters. Detach
 * is a change to what the deck is checked against going forward, not a
 * retraction of what already happened.
 *
 * Admin-gated because it is reached from the audit trail, which is admin-only. A
 * user retrieving their own uploaded document uses /InformationSource/Download,
 * which authorises by content hash.
 */
async function downloadVerificationSource(request, response)
{
    const queryParameters = await request.getQueryParams();

    // Packetron lower-cases query-parameter names, which is why the key here is
    // not the camelCase the client sends. Same as RefinementProofSource.
    const verificationSourceId = queryParameters ? queryParameters.verificationsourceid : null;

    if (typeof verificationSourceId !== "string" || verificationSourceId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const verificationSource = await PaidDeckVerificationSourceQueryEngine.findById(verificationSourceId);

    if (verificationSource === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.VERIFICATION_SOURCE_NOT_FOUND });
        return;
    }

    // A URL-only source has no bytes of ours to serve. Saying that plainly is
    // the useful answer — it is not a missing file, it is a source that never
    // had one, and the reader should follow the recorded URL instead.
    if (!verificationSource.informationSourceId && !verificationSource.contentHash)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({
            error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
            detail: "This source was declared as a reference URL, not an uploaded document, so there are no "
                + `stored bytes to download. The recorded address is: ${verificationSource.sourceUrl || "(none)"}`,
        });
        return;
    }

    const informationSource = verificationSource.informationSourceId
        ? await InformationSourceQueryEngine.getInformationSourceById(verificationSource.informationSourceId)
        : null;

    // Rebuilt from the information-source row when it is still there. The
    // storagePath stored on the verification source is the fallback, not the
    // first choice: it was composed at attach time and the row is the current
    // truth. It is used only when the information source is gone, which the
    // retention hold is supposed to prevent — so that case says so.
    let storagePath = "";
    let bRebuiltFromInformationSource = false;

    if (informationSource !== null)
    {
        storagePath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());
        bRebuiltFromInformationSource = true;
    }
    else if (typeof verificationSource.storagePath === "string" && verificationSource.storagePath.length > 0)
    {
        storagePath = verificationSource.storagePath;
    }

    if (storagePath.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({
            error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
            detail: "The document declared for this source is no longer stored and no path was recorded against it. "
                + "This should not happen — a declared source is held against deletion — and is worth investigating.",
        });
        return;
    }

    let fileData;

    try
    {
        fileData = await Persistence.read(storagePath, storageTargets.LINODE_OBJECT_STORAGE);
    }
    catch (readError)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({
            error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
            detail: bRebuiltFromInformationSource
                ? readError.message
                : "The document declared for this source could not be read from the path recorded at attach time, "
                    + `and its information-source row is gone. This should not happen: ${readError.message}`,
        });
        return;
    }

    const mimeType = (informationSource ? informationSource.getMimeType() : verificationSource.mimeType)
        || "application/octet-stream";
    const displayName = (informationSource ? informationSource.getName() : verificationSource.name)
        || "declared-source";

    response.setHeader("Content-Type", mimeType);
    response.setHeader("Content-Disposition", `attachment; filename="${buildSafeFileName(displayName)}"`);
    response.end(fileData);
}

/**
 * Strips anything from the stored name that could break out of the header. The
 * name came from a user's filesystem, so it is untrusted input in a response
 * header — quotes and control characters both matter.
 */
function buildSafeFileName(rawName)
{
    const cleanedName = String(rawName || "declared-source")
        .replace(/[\r\n"\\]/g, "")
        .replace(/[^\w.\- ]/g, "_")
        .trim();

    return cleanedName.length > 0 ? cleanedName.substring(0, 160) : "declared-source";
}

module.exports = { downloadVerificationSource };
