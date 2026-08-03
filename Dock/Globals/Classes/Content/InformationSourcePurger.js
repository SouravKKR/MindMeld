const path = require("path");
const InformationSourceQueryEngine = require("../Database/InformationSourceQueryEngine");
const DerivedContentQueryEngine = require("../Database/DerivedContentQueryEngine");
const StorageQuotaEnforcer = require("../Storage/StorageQuotaEnforcer");
const Persistence = require("../Persistence");
const { storageTargets } = require("../../Enumerations/StorageTargets");

/**
 * InformationSourcePurger
 *
 * The single removal path for an uploaded document and everything derived from
 * it. Three callers share it — the user-initiated delete endpoint, the expiry
 * reaper behind TEMPORARY retention, and the admin takedown endpoint — so the
 * cascade cannot drift between them.
 *
 * The ordering discipline it enforces:
 *
 *   1. Remove the information-source row(s) FIRST. The row is the user-facing
 *      entity and the billed footprint, so it must disappear even if a later
 *      storage step fails.
 *   2. Only then check whether any row still references the content hash.
 *      Checking after the delete means the row being removed isn't counted, and
 *      a wrongful blob delete can never precede the row removal.
 *   3. When nothing references the hash any more, remove the blob AND the
 *      derived content-addressed byproducts (embedding chunks, cached figures)
 *      in the same operation. These are keyed by hash alone, so they are
 *      unreachable from the row and would otherwise outlive the document.
 *
 * A storage-layer failure never fails the purge — the row is already gone and a
 * stray orphaned blob is harmless — but it is always reported back to the caller
 * so a takedown can be re-run rather than silently believed.
 */
class InformationSourcePurger
{
    /**
     * Removes one user's information source, cascading to the blob and derived
     * content only when this was the last row referencing that content.
     *
     * @param {InformationSource} informationSource - The row to remove.
     * @return {Promise<{bContentRemoved: boolean, embeddingChunksRemoved: number, figuresRemoved: number, storageError: string|null}>}
     */
    static async purgeSingleSource(informationSource)
    {
        await InformationSourceQueryEngine.deleteInformationSource(informationSource);

        const result = {
            bContentRemoved: false,
            embeddingChunksRemoved: 0,
            figuresRemoved: 0,
            storageError: null
        };

        try
        {
            // No last-reference check any more: storage is per-user, so this
            // row's blob and derived content belong to this user alone and
            // removing the row always means removing them.
            await InformationSourcePurger.#removeContentForSource(informationSource, result);
        }
        catch (cascadeError)
        {
            result.storageError = cascadeError?.message || String(cascadeError);
            console.warn(`[InformationSourcePurger] Row deleted but cascade failed for ${informationSource.getId()}: ${result.storageError}`);
        }

        StorageQuotaEnforcer.invalidate(informationSource.getUserId());

        return result;
    }

    /**
     * Removes EVERY tenant's row for a content hash, then the blob and all
     * derived content. This is the takedown path — it deliberately crosses the
     * tenant boundary, because a content-addressed store fans one uploaded file
     * out across every user who uploaded the same bytes, and a rightsholder
     * notice must reach all of them.
     *
     * @param {string} contentHash - The sha512 content-addressed key.
     * @return {Promise<{rowsRemoved: number, affectedUserIds: string[], bContentRemoved: boolean, embeddingChunksRemoved: number, figuresRemoved: number, storageError: string|null}>}
     */
    static async purgeAllSourcesWithContentHash(contentHash)
    {
        const matchingSources = await InformationSourceQueryEngine.getInformationSourcesByHash(contentHash);

        const result = {
            rowsRemoved: 0,
            affectedUserIds: [],
            bContentRemoved: false,
            embeddingChunksRemoved: 0,
            figuresRemoved: 0,
            storageError: null
        };

        // Capture the directory path before the rows go — it is only stored on
        // the row, and the blob key is derived from it.
        const directoryPath = matchingSources.length > 0 ? matchingSources[0].getDirectoryPath() : null;

        for (const informationSource of matchingSources)
        {
            await InformationSourceQueryEngine.deleteInformationSource(informationSource);
            result.rowsRemoved++;

            const ownerUserId = informationSource.getUserId();
            if (ownerUserId && !result.affectedUserIds.includes(ownerUserId))
            {
                result.affectedUserIds.push(ownerUserId);
            }
        }

        try
        {
            // The derived content is purged even when no row existed, so a
            // notice can still clear chunks left behind by an earlier partial
            // removal. The blob is only attempted when a row told us where it
            // lives.
            const purgeCounts = await DerivedContentQueryEngine.purgeByContentHash(contentHash);
            result.embeddingChunksRemoved = purgeCounts.embeddingChunksRemoved;
            result.figuresRemoved = purgeCounts.figuresRemoved;

            if (directoryPath !== null)
            {
                const blobPath = path.join(directoryPath, contentHash);
                await Persistence.delete(blobPath, storageTargets.LINODE_OBJECT_STORAGE);
                result.bContentRemoved = true;
            }
        }
        catch (cascadeError)
        {
            result.storageError = cascadeError?.message || String(cascadeError);
            console.warn(`[InformationSourcePurger] Takedown cascade failed for hash ${contentHash}: ${result.storageError}`);
        }

        for (const affectedUserId of result.affectedUserIds)
        {
            StorageQuotaEnforcer.invalidate(affectedUserId);
        }

        return result;
    }

    /**
     * Removes one user's blob plus the embedding chunks and cached figures
     * derived from it, recording the counts onto the supplied result object.
     */
    static async #removeContentForSource(informationSource, result)
    {
        const blobPath = path.join(informationSource.getDirectoryPath(), informationSource.getHash());
        await Persistence.delete(blobPath, storageTargets.LINODE_OBJECT_STORAGE);
        result.bContentRemoved = true;

        const purgeCounts = await DerivedContentQueryEngine.purgeForUserAndContentHash(
            informationSource.getUserId(),
            informationSource.getHash(),
        );
        result.embeddingChunksRemoved = purgeCounts.embeddingChunksRemoved;
        result.figuresRemoved = purgeCounts.figuresRemoved;
    }
}

module.exports = InformationSourcePurger;
