const path = require("path");
const ContentRefinementQueryEngine = require("../../../Globals/Classes/Database/ContentRefinementQueryEngine");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Admin/PaidDecks/RefinementProofSource?refinementId=...
 *
 * Streams back the reference document a content refinement was made against.
 *
 * This is the other half of the licence declaration. Recording "this correction
 * was written against a CC0 source" is worth nothing on its own — the assertion
 * only means something while the document behind it can still be produced. The
 * retention hold keeps the bytes; this endpoint is how they are reached.
 *
 * THE STORAGE PATH IS NEVER TAKEN FROM THE REQUEST. The caller names a
 * refinement; the path is rebuilt from the information-source row that
 * refinement recorded. Following DownloadSupportAttachment: a request that could
 * name a path is a request that could name any path.
 *
 * Admin-gated because it is reached from the audit trail, which is admin-only.
 * A user retrieving their own attached source uses the existing
 * /InformationSource/Download, which authorises by content hash.
 */
async function downloadRefinementProofSource(request, response)
{
    const queryParameters = await request.getQueryParams();
    const refinementId = queryParameters ? queryParameters.refinementid : null;

    if (typeof refinementId !== "string" || refinementId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const refinement = await ContentRefinementQueryEngine.findById(refinementId);

    if (refinement === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
        return;
    }

    if (!refinement.informationSourceId)
    {
        // Not an error to paper over: most refinements are made from an
        // instruction alone and have no document behind them. Saying so is the
        // useful answer.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({
            error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
            detail: "This correction was made from a written instruction; no reference document was attached to it.",
        });
        return;
    }

    const informationSource = await InformationSourceQueryEngine.getInformationSourceById(refinement.informationSourceId);

    if (informationSource === null)
    {
        // The retention hold exists precisely so this cannot happen. If it does,
        // the hold has a hole in it and the message should say so rather than
        // reading as an ordinary missing file.
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({
            error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
            detail: "The reference document recorded against this correction is no longer stored. "
                + "This should not happen — it is held against deletion — and is worth investigating.",
        });
        return;
    }

    const storagePath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());

    let fileData;

    try
    {
        fileData = await Persistence.read(storagePath, storageTargets.LINODE_OBJECT_STORAGE);
    }
    catch (readError)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND, detail: readError.message });
        return;
    }

    response.setHeader("Content-Type", informationSource.getMimeType() || "application/octet-stream");
    response.setHeader("Content-Disposition", `attachment; filename="${buildSafeFileName(informationSource.getName())}"`);
    response.end(fileData);
}

/**
 * Strips anything from the stored name that could break out of the header. The
 * name came from a user's filesystem, so it is untrusted input in a response
 * header — quotes and control characters both matter.
 */
function buildSafeFileName(rawName)
{
    const cleanedName = String(rawName || "reference-source")
        .replace(/[\r\n"\\]/g, "")
        .replace(/[^\w.\- ]/g, "_")
        .trim();

    return cleanedName.length > 0 ? cleanedName.substring(0, 160) : "reference-source";
}

module.exports = { downloadRefinementProofSource };
