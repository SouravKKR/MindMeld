const InformationSourceQueryEngine = require("../Database/InformationSourceQueryEngine");
const DerivedContentPurger = require("./DerivedContentPurger");
const EmbeddedFigurePurger = require("./EmbeddedFigurePurger");
const StorageQuotaEnforcer = require("../Storage/StorageQuotaEnforcer");
const Persistence = require("../Persistence");
const { joinPath } = require("../../UtilityFunctions.js/JoinPath");
const { storageTargets } = require("../../Enumerations/StorageTargets");

/**
 * InformationSourcePurger
 *
 * The single removal path for an uploaded document and everything derived from
 * it. Four callers share it — the user-initiated delete endpoint, the expiry
 * reaper behind TEMPORARY retention, account closure, and the admin takedown
 * endpoint — so the cascade cannot drift between them.
 *
 * The ordering discipline it enforces:
 *
 *   1. Remove the information-source row(s) FIRST. The row is the user-facing
 *      entity and the billed footprint, so it must disappear even if a later
 *      storage step fails.
 *   2. Delete the stored bytes ONE COPY PER ROW, each from that row's own
 *      directory. Storage is per-user: the hash names the object but does not
 *      dedupe across accounts, so N holders means N distinct blobs. Deriving a
 *      single path and issuing a single delete — correct when the store was
 *      content-addressed and shared — leaves every other holder's copy in place.
 *   3. Hand the derived byproducts to DerivedContentPurger, which removes the
 *      embedding chunks, the figure rows and the figure PNGs those rows point
 *      at. They are keyed on (user, hash) rather than reachable from the row, so
 *      they would otherwise outlive the document.
 *   4. Hand the SYNCED entities to EmbeddedFigurePurger, which strips the
 *      figures the document contributed out of study material bodies and card
 *      faces and republishes them so devices drop their copies. Steps 2 and 3
 *      remove the copies the server keeps for itself; this removes the copy the
 *      reader is actually looking at, which is a base64 payload living inside a
 *      different entity and reachable from nothing the first three steps touch.
 *
 * A storage-layer failure never fails the purge — the row is already gone — but
 * it is always reported back to the caller, and a partial removal is never
 * reported as a complete one. bContentRemoved means every stored copy this
 * purge could locate was deleted; anything less leaves it false with the reason
 * in storageError, because a takedown register that records unremoved content as
 * removed is a false evidentiary record rather than a stale field.
 */
class InformationSourcePurger
{
    /**
     * Removes one user's information source, its stored blob, and everything
     * derived from it.
     *
     * @param {InformationSource} informationSource - The row to remove.
     * @return {Promise<{bContentRemoved: boolean, embeddingChunksRemoved: number, figuresRemoved: number, figureObjectsRemoved: number, storageError: string|null}>}
     */
    static async purgeSingleSource(informationSource)
    {
        await InformationSourceQueryEngine.deleteInformationSource(informationSource);

        const result = {
            bContentRemoved: false,
            embeddingChunksRemoved: 0,
            figuresRemoved: 0,
            figureObjectsRemoved: 0,
            embeddedFiguresStripped: 0,
            studyMaterialsRewritten: 0,
            cardsRewritten: 0,
            unstrippableDocumentCount: 0,
            storageError: null
        };

        try
        {
            // No last-reference check on the BLOB: storage is per-user, so this
            // row's copy belongs to this user alone and removing the row always
            // means removing it. The figure objects are different — one PNG is
            // addressed by (user, perceptual hash), so two of the user's own
            // documents can share it — and DerivedContentPurger runs that check
            // for them.
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
     * Removes EVERY tenant's row for a content hash, then every stored copy of
     * the bytes and all derived content. This is the takedown path — it
     * deliberately crosses the tenant boundary, because a rightsholder notice is
     * about the work rather than about one account.
     *
     * Storage is per-user, so "the blob" is a set, not a single object: each
     * holder has their own copy under their own directory, and the notice is
     * only honoured when all of them are gone. countStoredCopies reports the
     * size of that set to the dry run, so an operator sees how many copies a
     * notice will reach before actioning it.
     *
     * @param {string} contentHash - The sha512 content-addressed key.
     * @return {Promise<{rowsRemoved: number, rowsFailed: number, affectedUserIds: string[], storedCopiesFound: number, storedCopiesRemoved: number, unlocatableRowCount: number, bContentRemoved: boolean, embeddingChunksRemoved: number, figuresRemoved: number, figureObjectsRemoved: number, storageError: string|null}>}
     */
    static async purgeAllSourcesWithContentHash(contentHash)
    {
        const matchingSources = await InformationSourceQueryEngine.getInformationSourcesByHash(contentHash);

        const result = {
            rowsRemoved: 0,
            rowsFailed: 0,
            affectedUserIds: [],
            storedCopiesFound: 0,
            storedCopiesRemoved: 0,
            unlocatableRowCount: 0,
            bContentRemoved: false,
            embeddingChunksRemoved: 0,
            figuresRemoved: 0,
            figureObjectsRemoved: 0,
            embeddedFiguresStripped: 0,
            studyMaterialsRewritten: 0,
            cardsRewritten: 0,
            unstrippableDocumentCount: 0,
            storageError: null
        };

        // Capture EVERY row's own blob path before the rows go — the path lives
        // only on the row, and with per-user storage each holder's copy is a
        // distinct object. A row that never recorded where its bytes live is
        // counted separately: it cannot be located, so the removal cannot be
        // called complete.
        const blobPathsToRemove = [];
        for (const informationSource of matchingSources)
        {
            const blobPath = InformationSourcePurger.#buildBlobPath(informationSource.getDirectoryPath(), contentHash);
            if (blobPath === null)
            {
                result.unlocatableRowCount++;
                continue;
            }

            if (!blobPathsToRemove.includes(blobPath))
            {
                blobPathsToRemove.push(blobPath);
            }
        }
        result.storedCopiesFound = blobPathsToRemove.length;

        const cascadeErrors = [];

        for (const informationSource of matchingSources)
        {
            try
            {
                await InformationSourceQueryEngine.deleteInformationSource(informationSource);
                result.rowsRemoved++;
            }
            catch (rowError)
            {
                // One row that will not delete must not strand the rest of the
                // notice — the remaining tenants are still entitled to removal.
                result.rowsFailed++;
                cascadeErrors.push(`row ${informationSource.getId()}: ${rowError?.message || rowError}`);
                console.warn(`[InformationSourcePurger] Takedown could not delete row ${informationSource.getId()}: ${rowError?.message || rowError}`);
                continue;
            }

            const ownerUserId = informationSource.getUserId();
            if (ownerUserId && !result.affectedUserIds.includes(ownerUserId))
            {
                result.affectedUserIds.push(ownerUserId);
            }
        }

        for (const blobPath of blobPathsToRemove)
        {
            try
            {
                await Persistence.delete(blobPath, storageTargets.LINODE_OBJECT_STORAGE);
                result.storedCopiesRemoved++;
            }
            catch (blobError)
            {
                cascadeErrors.push(`blob ${blobPath}: ${blobError?.message || blobError}`);
                console.warn(`[InformationSourcePurger] Takedown could not delete blob ${blobPath}: ${blobError?.message || blobError}`);
            }
        }

        try
        {
            // The derived content is purged even when no row existed, so a
            // notice can still clear chunks and figure objects left behind by an
            // earlier partial removal.
            const purgeCounts = await DerivedContentPurger.purgeByContentHash(contentHash);
            result.embeddingChunksRemoved = purgeCounts.embeddingChunksRemoved;
            result.figuresRemoved = purgeCounts.figuresRemoved;
            result.figureObjectsRemoved = purgeCounts.figureObjectsRemoved;
            if (purgeCounts.storageError !== null)
            {
                cascadeErrors.push(purgeCounts.storageError);
            }
        }
        catch (derivedError)
        {
            cascadeErrors.push(`derived content: ${derivedError?.message || derivedError}`);
            console.warn(`[InformationSourcePurger] Takedown derived-content cascade failed for hash ${contentHash}: ${derivedError?.message || derivedError}`);
        }

        try
        {
            // Crosses the tenant boundary like everything else on this path, and
            // for the same reason: the embedded copy is a copy of the noticed
            // work no matter whose library it ended up in.
            const embeddedFigureCounts = await EmbeddedFigurePurger.purgeByContentHash(contentHash);
            result.embeddedFiguresStripped = embeddedFigureCounts.figuresStripped;
            result.studyMaterialsRewritten = embeddedFigureCounts.studyMaterialsUpdated;
            result.cardsRewritten = embeddedFigureCounts.cardsUpdated;
            result.unstrippableDocumentCount = embeddedFigureCounts.unbalancedDocumentCount;

            if (embeddedFigureCounts.unbalancedDocumentCount > 0)
            {
                cascadeErrors.push(`${embeddedFigureCounts.unbalancedDocumentCount} entity/entities carried an unclosed figure element and were left unmodified.`);
            }
        }
        catch (embeddedFigureError)
        {
            cascadeErrors.push(`embedded figures: ${embeddedFigureError?.message || embeddedFigureError}`);
            console.warn(`[InformationSourcePurger] Takedown embedded-figure sweep failed for hash ${contentHash}: ${embeddedFigureError?.message || embeddedFigureError}`);
        }

        // Complete means EVERY located copy went, no row resisted deletion, no
        // row was unlocatable, and no entity still carries an embedded copy of
        // the artwork. That last clause is what stops the register recording a
        // notice as honoured while the picture is still on screen — the exact
        // failure this sweep was added for.
        result.bContentRemoved = result.storedCopiesFound > 0
            && result.storedCopiesRemoved === result.storedCopiesFound
            && result.rowsFailed === 0
            && result.unlocatableRowCount === 0
            && result.unstrippableDocumentCount === 0;

        if (result.unlocatableRowCount > 0)
        {
            cascadeErrors.push(`${result.unlocatableRowCount} row(s) recorded no directory path, so their stored copy could not be located.`);
        }

        if (cascadeErrors.length > 0)
        {
            result.storageError = cascadeErrors.join(" | ");
        }

        for (const affectedUserId of result.affectedUserIds)
        {
            StorageQuotaEnforcer.invalidate(affectedUserId);
        }

        return result;
    }

    /**
     * Counts the distinct stored copies a takedown for this hash would have to
     * delete. Reported by the dry run, because "one notice, N copies" is exactly
     * the fact an operator needs before actioning an irreversible removal.
     *
     * @param {InformationSource[]} matchingSources - Every row referencing the hash.
     * @param {string} contentHash - The sha512 content-addressed key.
     * @return {number}
     */
    static countStoredCopies(matchingSources, contentHash)
    {
        const distinctBlobPaths = new Set();

        for (const informationSource of matchingSources)
        {
            const blobPath = InformationSourcePurger.#buildBlobPath(informationSource.getDirectoryPath(), contentHash);
            if (blobPath !== null)
            {
                distinctBlobPaths.add(blobPath);
            }
        }

        return distinctBlobPaths.size;
    }

    /**
     * Removes one user's blob plus the embedding chunks, figure rows and figure
     * objects derived from it, recording the counts onto the supplied result.
     *
     * The two halves are independent on purpose. A blob delete that fails must
     * not skip the derived purge: the page text and figure crops of the document
     * are the more sensitive residue, and leaving them because the source object
     * would not delete is the wrong trade in both directions.
     */
    static async #removeContentForSource(informationSource, result)
    {
        const cascadeErrors = [];
        const blobPath = InformationSourcePurger.#buildBlobPath(informationSource.getDirectoryPath(), informationSource.getHash());

        if (blobPath === null)
        {
            // A row with no directory path predates per-user storage or was
            // written incompletely. Deleting a path guessed from the hash alone
            // could remove an unrelated object, so it is reported instead.
            cascadeErrors.push(`Row ${informationSource.getId()} recorded no directory path, so its stored copy could not be located.`);
        }
        else
        {
            try
            {
                await Persistence.delete(blobPath, storageTargets.LINODE_OBJECT_STORAGE);
                result.bContentRemoved = true;
            }
            catch (blobError)
            {
                cascadeErrors.push(`blob ${blobPath}: ${blobError?.message || blobError}`);
            }
        }

        const purgeCounts = await DerivedContentPurger.purgeForUserAndContentHash(
            informationSource.getUserId(),
            informationSource.getHash(),
        );
        result.embeddingChunksRemoved = purgeCounts.embeddingChunksRemoved;
        result.figuresRemoved = purgeCounts.figuresRemoved;
        result.figureObjectsRemoved = purgeCounts.figureObjectsRemoved;

        // Runs even when the blob delete failed, for the same reason the derived
        // purge does: the embedded copies are the ones a reader can see, so they
        // are the last thing that should be skipped because an object-storage
        // call went wrong.
        try
        {
            const embeddedFigureCounts = await EmbeddedFigurePurger.purgeForUserAndContentHash(
                informationSource.getUserId(),
                informationSource.getHash(),
            );
            result.embeddedFiguresStripped = embeddedFigureCounts.figuresStripped;
            result.studyMaterialsRewritten = embeddedFigureCounts.studyMaterialsUpdated;
            result.cardsRewritten = embeddedFigureCounts.cardsUpdated;
            result.unstrippableDocumentCount = embeddedFigureCounts.unbalancedDocumentCount;

            if (embeddedFigureCounts.unbalancedDocumentCount > 0)
            {
                cascadeErrors.push(`${embeddedFigureCounts.unbalancedDocumentCount} entity/entities carried an unclosed figure element and were left unmodified.`);
            }
        }
        catch (embeddedFigureError)
        {
            cascadeErrors.push(`embedded figures: ${embeddedFigureError?.message || embeddedFigureError}`);
        }

        // The rows are gone but an object survived. Surfacing it keeps the
        // caller's "removed" report honest and lets the reaper's orphan sweep be
        // the backstop rather than the only line of defence.
        if (purgeCounts.storageError !== null)
        {
            cascadeErrors.push(purgeCounts.storageError);
        }

        if (cascadeErrors.length > 0)
        {
            result.storageError = cascadeErrors.join(" | ");
        }
    }

    /**
     * Builds the object key for a stored document, or null when the row cannot
     * say where its bytes live.
     *
     * The null branch is load-bearing. joinPath drops empty segments, so a
     * missing directory path silently collapses "<directory>/<hash>" to "<hash>"
     * — a real key at the bucket root belonging to something else entirely.
     */
    static #buildBlobPath(directoryPath, contentHash)
    {
        if (typeof directoryPath !== "string" || directoryPath.length === 0)
        {
            return null;
        }

        if (typeof contentHash !== "string" || contentHash.length === 0)
        {
            return null;
        }

        return joinPath("/", directoryPath, contentHash);
    }
}

module.exports = InformationSourcePurger;
