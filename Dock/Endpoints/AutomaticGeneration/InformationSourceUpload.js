const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const InformationSource = require("../../Globals/Model/InformationSource");
const { getUser } = require("../Helpers/GetUser");
const { computeFileSha512Hash } = require("../../Globals/UtilityFunctions.js/ComputeFileSha512Hash");
const Persistence = require("../../Globals/Classes/Persistence");
const { storageTargets } = require("../../Globals/Enumerations/StorageTargets");
const InformationSourceQueryEngine = require("../../Globals/Classes/Database/InformationSourceQueryEngine");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const { joinPath } = require("../../Globals/UtilityFunctions.js/JoinPath");
const OcrLocalFile = require("./Helpers/OcrLocalFile");
const UploadQuotaManager = require("../../Globals/Classes/Quotas/UploadQuotaManager");
const fs = require("fs");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

const uploadQuotaManager = new UploadQuotaManager();


/**
 * Handles the upload of an information source. Expects the InformationSource
 * JSON as a "metadata" query parameter and the file under multipart field
 * "file".
 *
 * Storage contract (content-addressed):
 *   - The CAS key is sha512(originalFileBytes).
 *   - The GCS object at that key is ALWAYS the OCRed PDF — the original is
 *     never written to GCS. OCR runs synchronously on this host before the
 *     GCS upload, so the invariant "if it exists in GCS, it is OCRed" holds
 *     by construction. Crashes between OCR and DB save leave nothing in
 *     GCS, so a retry uploads cleanly.
 *   - If any user has already uploaded the same content the existing GCS
 *     object is reused — neither OCR nor upload repeats.
 *   - Per-user dedup uses the same CAS key, so a user can't see two
 *     entries for the same content.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 * @returns {Promise<void>}
 */
async function handleInformationSourceUpload(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorized.");
        return;
    }

    const queryParams = await request.getQueryParams();
    const files = await request.getFiles();
    const uploadedFilePath = files.file;

    let fileSizeBytes = 0;
    try
    {
        fileSizeBytes = fs.statSync(uploadedFilePath).size;
    }
    catch (statError)
    {
        fileSizeBytes = 0;
    }

    const quotaCheck = await uploadQuotaManager.check(user.getId(), fileSizeBytes);
    if (!quotaCheck.allowed)
    {
        response.statusCode = httpStatus.TOO_MANY_REQUESTS;
        response.sendJson({
            error: "UPLOAD_QUOTA_EXCEEDED",
            reason: quotaCheck.reason,
            remainingFiles: quotaCheck.remainingFiles,
            remainingBytes: quotaCheck.remainingBytes,
            resetAt: quotaCheck.resetAt
        });
        return;
    }

    const metadataJson = JSON.parse(queryParams.metadata);
    const informationSource = InformationSource.fromJson(metadataJson);

    const contentAddressedKey = await computeFileSha512Hash(uploadedFilePath);

    informationSource.setUserId(user.getId());
    informationSource.setHash(contentAddressedKey);

    // Persist the measured upload size so the storage-credit assessor can
    // bill the GCS-bucket footprint without re-reading the blob. retentionMode
    // arrives in the metadata JSON (TEMPORARY sources are exempt from storage
    // billing); fromJson defaults it to PERMANENT when the client omits it.
    informationSource.setFileSizeBytes(fileSizeBytes);

    const bIsDuplicate = await InformationSourceQueryEngine.doesUserAlreadyHaveInformationSourceWithSameContent(
        user.getId(),
        contentAddressedKey,
    );

    if (bIsDuplicate)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.end("You have already uploaded a source with the same content.");
        return;
    }

    const informationSourceDirectory = joinPath("/", PersistenceConstants.INFORMATION_SOURCE_DIRECTORY);
    const informationSourcePath = joinPath("/", informationSourceDirectory, contentAddressedKey);

    informationSource.setDirectoryPath(informationSourceDirectory);

    // ── Global CAS check ──
    // If the OCRed PDF for this content already exists in GCS (uploaded by
    // any user), reuse it — skip OCR entirely.
    const bAlreadyInContentStore = await Persistence.exists(informationSourcePath, storageTargets.GOOGLE_CLOUD_STORAGE);

    if (bAlreadyInContentStore)
    {
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
        await uploadQuotaManager.record(user.getId(), fileSizeBytes);
        response.sendJson(informationSource.toJson());
        return;
    }

    // ── First-time upload: OCR locally, then upload only the OCRed PDF ──
    // The original is never written to GCS, so a crash here cannot leave a
    // non-OCRed object masquerading as a CAS hit.
    let ocrOutputPath = null;

    try
    {
        ocrOutputPath = await OcrLocalFile.run(uploadedFilePath);
    }
    catch (ocrError)
    {
        console.error(`[InformationSourceUpload] OCR failed: ${ocrError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "OCR_FAILED", reason: ocrError.message });
        return;
    }

    try
    {
        await Persistence.move(
            ocrOutputPath,
            storageTargets.LOCAL_FILE_SYSTEM,
            informationSourcePath,
            storageTargets.GOOGLE_CLOUD_STORAGE,
        );
    }
    catch (uploadError)
    {
        try { fs.unlinkSync(ocrOutputPath); } catch (_) {}
        console.error(`[InformationSourceUpload] GCS upload failed: ${uploadError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "GCS_UPLOAD_FAILED", reason: uploadError.message });
        return;
    }

    try
    {
        await InformationSourceQueryEngine.saveInformationSource(informationSource);
    }
    catch (saveError)
    {
        // Do NOT delete the GCS object here. It is content-addressed and
        // either (a) belongs to another user's earlier successful upload
        // (CAS sharing), or (b) belongs to a concurrent same-user request
        // (R1) that just inserted the canonical row — the row we're now
        // colliding with on the userId_1_hash_1 unique index. Deleting it
        // would leave R1's row pointing at a missing object and break
        // downstream readers.
        const bIsDuplicateKeyError = saveError?.code === 11000 || /E11000/.test(saveError?.message ?? "");

        if (bIsDuplicateKeyError)
        {
            console.warn(`[InformationSourceUpload] Concurrent upload race resolved by unique index for ${user.getId()}/${contentAddressedKey}.`);
            response.statusCode = httpStatus.CONFLICT;
            response.end("You have already uploaded a source with the same content.");
            return;
        }

        console.error(`[InformationSourceUpload] DB save failed after OCR + GCS upload: ${saveError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "DB_SAVE_FAILED", reason: saveError.message });
        return;
    }

    await uploadQuotaManager.record(user.getId(), fileSizeBytes);
    response.sendJson(informationSource.toJson());
}

module.exports = { handleInformationSourceUpload };
