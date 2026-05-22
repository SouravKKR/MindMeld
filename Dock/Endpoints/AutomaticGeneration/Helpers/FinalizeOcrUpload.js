const Persistence = require("../../../Globals/Classes/Persistence");
const { storageTargets } = require("../../../Globals/Enumerations/StorageTargets");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const TaskManager = require("../../../Globals/Classes/Task/TaskManager");


/**
 * Runs the OCR task to completion and finalizes the upload — either persists
 * the InformationSource to the DB on success, or rolls back the CAS object
 * on failure. Called fire-and-forget from InformationSourceUpload so the
 * HTTP response returns the pending task ID immediately and the client can
 * poll /Generate/Progress for the OCR phase.
 *
 * Side effects:
 *   - On success: saves the InformationSource via the query engine. The
 *     polling client then sees task status == COMPLETED.
 *   - On failure: deletes the GCS object so a future upload of the same
 *     content isn't blocked by a half-processed file. Task status is set
 *     to FAILED by TaskManager.execute, which the polling client surfaces
 *     as an error.
 */
async function finalizeOcrUpload({ ocrTaskDescriptor, informationSource, informationSourcePath })
{
    let bOcrSucceeded = false;

    try
    {
        bOcrSucceeded = await TaskManager.execute(ocrTaskDescriptor);
    }
    catch (executionError)
    {
        console.error(`[FinalizeOcrUpload] OCR task threw: ${executionError.message}`);
        bOcrSucceeded = false;
    }

    if (!bOcrSucceeded)
    {
        try
        {
            await Persistence.delete(informationSourcePath, storageTargets.GOOGLE_CLOUD_STORAGE);
        }
        catch (deleteError)
        {
            console.error(`[FinalizeOcrUpload] OCR failed and rollback delete also failed: ${deleteError.message}`);
        }
        return;
    }

    try
    {
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
    }
    catch (saveError)
    {
        console.error(`[FinalizeOcrUpload] DB save failed after successful OCR: ${saveError.message}`);
    }
}

module.exports = { finalizeOcrUpload };
