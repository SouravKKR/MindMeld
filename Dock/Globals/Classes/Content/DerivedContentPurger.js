const DerivedContentQueryEngine = require("../Database/DerivedContentQueryEngine");
const Persistence = require("../Persistence");
const PersistenceConstants = require("../../Constants/PersistenceConstants");
const { storageTargets } = require("../../Enumerations/StorageTargets");

/**
 * DerivedContentPurger
 *
 * The removal path for everything the Agent derives from an uploaded document —
 * the verbatim page-text chunks, the figure rows, AND the figure PNGs those rows
 * point at in object storage.
 *
 * This class exists because the row half and the object half were split. The
 * Agent writes each validated figure crop to figures/<userId>/<perceptualHash>.png
 * and records the key on the row; every deletion path then removed the row and
 * left the PNG. That made the object simultaneously undeletable — the row was
 * the only record of its key — and unattributable, while the Privacy Policy
 * states an uploaded document is deleted together with the images extracted from
 * it. A cascade that stops at the row keeps the promise for the record and
 * breaks it for the bytes.
 *
 * The ordering discipline, which is what makes it correct:
 *
 *   1. Read the candidate storage paths FIRST, while the rows still exist. After
 *      the rows go there is nothing left to read them from.
 *   2. Delete the rows. They are the user-facing artefacts, so they must
 *      disappear even if a later storage step fails.
 *   3. Re-check which of those paths a SURVIVING row still references, and
 *      delete only the rest. One PNG is addressed by (user, perceptual hash),
 *      not by document, so two documents of one user containing the same
 *      illustration share a single object. Checking after the delete is what
 *      makes "no row references it any more" mean what it says.
 *
 * A storage failure never fails the purge — the rows are already gone and a
 * stray object is reclaimed by sweepOrphanedFigureObjects — but it is always
 * reported to the caller so a takedown can be re-run rather than believed.
 */
class DerivedContentPurger
{
    // Objects younger than this are never swept. The Agent writes the PNG before
    // it upserts the row, so a sweep landing in that window would delete a live
    // figure that simply had not been recorded yet. The window is hours wide
    // against a sub-second gap because the cost of waiting is a stale object and
    // the cost of not waiting is losing a figure a user is about to see.
    static #ORPHAN_MINIMUM_AGE_MILLISECONDS = 24 * 60 * 60 * 1000;

    /**
     * Removes one user's derived content for one document, objects included.
     *
     * @param {string} userId - The owning user.
     * @param {string} contentHash - The sha512 of the source document.
     * @return {Promise<{embeddingChunksRemoved: number, figuresRemoved: number, figureObjectsRemoved: number, figureObjectsFailed: number, storageError: string|null}>}
     */
    static async purgeForUserAndContentHash(userId, contentHash)
    {
        const candidateStoragePaths = await DerivedContentQueryEngine.getFigureStoragePathsForUserAndContentHash(userId, contentHash);
        const rowCounts = await DerivedContentQueryEngine.purgeForUserAndContentHash(userId, contentHash);

        return await DerivedContentPurger.#completeCascade(rowCounts, candidateStoragePaths);
    }

    /**
     * Removes EVERY tenant's derived content for one document, objects included.
     * Takedown path only — it crosses the tenant boundary by design.
     *
     * @param {string} contentHash - The sha512 of the source document.
     * @return {Promise<{embeddingChunksRemoved: number, figuresRemoved: number, figureObjectsRemoved: number, figureObjectsFailed: number, storageError: string|null}>}
     */
    static async purgeByContentHash(contentHash)
    {
        const candidateStoragePaths = await DerivedContentQueryEngine.getFigureStoragePathsByContentHash(contentHash);
        const rowCounts = await DerivedContentQueryEngine.purgeByContentHash(contentHash);

        return await DerivedContentPurger.#completeCascade(rowCounts, candidateStoragePaths);
    }

    /**
     * Removes every derived artefact belonging to one user — every document,
     * plus a listing of that user's figure prefix.
     *
     * Account closure calls this after the per-document purges have run. The
     * prefix listing is the part the per-document paths cannot supply: an object
     * whose row was already lost is invisible to a row-driven purge, and erasure
     * has to mean the bytes are gone, not that the records pointing at them are.
     *
     * @param {string} userId - The account being closed.
     * @return {Promise<{embeddingChunksRemoved: number, figuresRemoved: number, figureObjectsRemoved: number, figureObjectsFailed: number, storageError: string|null}>}
     */
    static async purgeAllForUser(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return DerivedContentPurger.#emptyResult();
        }

        const recordedStoragePaths = await DerivedContentQueryEngine.getFigureStoragePathsForUser(userId);
        const rowCounts = await DerivedContentQueryEngine.purgeAllForUser(userId);

        // Every object under the user's prefix, not only the recorded ones. The
        // account is going away, so there is no surviving row that could
        // legitimately reference anything here and no last-reference check to
        // make — unlike every other path in this class.
        let storedObjectPaths = [];
        try
        {
            storedObjectPaths = await Persistence.list(
                DerivedContentPurger.#buildUserFigurePrefix(userId),
                storageTargets.LINODE_OBJECT_STORAGE,
            );
        }
        catch (listError)
        {
            console.warn(`[DerivedContentPurger] Could not list figure prefix for ${userId}: ${listError?.message || listError}`);
        }

        const pathsToRemove = [...new Set([...recordedStoragePaths, ...storedObjectPaths])];
        const objectRemoval = await DerivedContentPurger.#removeObjects(pathsToRemove);

        return Object.assign({ embeddingChunksRemoved: rowCounts.embeddingChunksRemoved, figuresRemoved: rowCounts.figuresRemoved }, objectRemoval);
    }

    /**
     * Reclaims figure objects that no row points at any more — residue of a
     * cascade interrupted between the row delete and the object delete, and of
     * everything written before the cascade covered objects at all.
     *
     * Bounded per call and safe to run unattended: an object is only removed
     * when it is older than the write-to-record window AND no figure row
     * references it. A listing that succeeds but a row lookup that throws
     * deletes nothing, because the lookup failure propagates before any delete.
     *
     * The bound is a window, not a prefix of the bucket. Each call resumes after
     * the last key the previous one saw and returns where to resume next, so the
     * scan walks the whole prefix over successive ticks. Without that the sweep
     * would re-read the same leading keys forever and never reach an orphan
     * sorting after them — a reclaim job that only ever inspects the head of the
     * bucket is indistinguishable from no reclaim job at all. A null return means
     * the end was reached and the next call should start from the beginning.
     *
     * @param {number} maximumObjectsToInspect - Bound on the work done per sweep.
     * @param {number} nowMilliseconds - Current UTC time, injected so the age gate is testable.
     * @param {string|null} startAfterPath - Where the previous sweep stopped, or null to start from the beginning.
     * @return {Promise<{inspectedCount: number, figureObjectsRemoved: number, figureObjectsFailed: number, nextStartAfterPath: string|null, storageError: string|null}>}
     */
    static async sweepOrphanedFigureObjects(maximumObjectsToInspect, nowMilliseconds, startAfterPath = null)
    {
        const listedObjects = await Persistence.listWithMetadata(
            DerivedContentPurger.#buildFigurePrefix(),
            storageTargets.LINODE_OBJECT_STORAGE,
            maximumObjectsToInspect,
            startAfterPath,
        );

        // A short page means the prefix ran out, so the next sweep wraps to the
        // beginning rather than resuming past the end and inspecting nothing.
        const nextStartAfterPath = listedObjects.length >= maximumObjectsToInspect
            ? listedObjects[listedObjects.length - 1].path
            : null;

        const ageThresholdMilliseconds = nowMilliseconds - DerivedContentPurger.#ORPHAN_MINIMUM_AGE_MILLISECONDS;
        const candidateStoragePaths = listedObjects
            .filter(listedObject => listedObject.lastModifiedMilliseconds > 0 && listedObject.lastModifiedMilliseconds < ageThresholdMilliseconds)
            .map(listedObject => listedObject.path);

        if (candidateStoragePaths.length === 0)
        {
            return {
                inspectedCount: listedObjects.length,
                figureObjectsRemoved: 0,
                figureObjectsFailed: 0,
                nextStartAfterPath: nextStartAfterPath,
                storageError: null
            };
        }

        const referencedStoragePaths = await DerivedContentQueryEngine.getReferencedFigureStoragePaths(candidateStoragePaths);
        const orphanedStoragePaths = candidateStoragePaths.filter(candidateStoragePath => !referencedStoragePaths.has(candidateStoragePath));

        const objectRemoval = await DerivedContentPurger.#removeObjects(orphanedStoragePaths);

        return {
            inspectedCount: listedObjects.length,
            figureObjectsRemoved: objectRemoval.figureObjectsRemoved,
            figureObjectsFailed: objectRemoval.figureObjectsFailed,
            nextStartAfterPath: nextStartAfterPath,
            storageError: objectRemoval.storageError
        };
    }

    /**
     * Step 3 of the ordering discipline: drop the objects the just-deleted rows
     * were the last reference to, and fold the counts into the row result.
     */
    static async #completeCascade(rowCounts, candidateStoragePaths)
    {
        const result = {
            embeddingChunksRemoved: rowCounts.embeddingChunksRemoved,
            figuresRemoved: rowCounts.figuresRemoved,
            figureObjectsRemoved: 0,
            figureObjectsFailed: 0,
            storageError: null
        };

        if (candidateStoragePaths.length === 0)
        {
            return result;
        }

        const referencedStoragePaths = await DerivedContentQueryEngine.getReferencedFigureStoragePaths(candidateStoragePaths);
        const unreferencedStoragePaths = candidateStoragePaths.filter(candidateStoragePath => !referencedStoragePaths.has(candidateStoragePath));

        return Object.assign(result, await DerivedContentPurger.#removeObjects(unreferencedStoragePaths));
    }

    /**
     * Deletes each object independently. One failure must not abandon the rest —
     * a half-run cascade is exactly the state this class exists to prevent — so
     * the failures are collected and reported together.
     */
    static async #removeObjects(storagePathsToRemove)
    {
        let figureObjectsRemoved = 0;
        const failedStoragePaths = [];

        for (const storagePath of storagePathsToRemove)
        {
            try
            {
                await Persistence.delete(storagePath, storageTargets.LINODE_OBJECT_STORAGE);
                figureObjectsRemoved = figureObjectsRemoved + 1;
            }
            catch (deleteError)
            {
                failedStoragePaths.push(storagePath);
                console.warn(`[DerivedContentPurger] Could not delete figure object ${storagePath}: ${deleteError?.message || deleteError}`);
            }
        }

        return {
            figureObjectsRemoved: figureObjectsRemoved,
            figureObjectsFailed: failedStoragePaths.length,
            storageError: failedStoragePaths.length > 0
                ? `${failedStoragePaths.length} figure object(s) could not be deleted (first: ${failedStoragePaths[0]}).`
                : null
        };
    }

    static #buildFigurePrefix()
    {
        return `${PersistenceConstants.FIGURE_DIRECTORY}/`;
    }

    static #buildUserFigurePrefix(userId)
    {
        return `${PersistenceConstants.FIGURE_DIRECTORY}/${userId}/`;
    }

    static #emptyResult()
    {
        return {
            embeddingChunksRemoved: 0,
            figuresRemoved: 0,
            figureObjectsRemoved: 0,
            figureObjectsFailed: 0,
            storageError: null
        };
    }
}

module.exports = DerivedContentPurger;
