const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * DerivedContentQueryEngine
 *
 * Owns the byproducts the Agent derives from an uploaded document — the verbatim
 * page-text chunks in `textEmbeddings` and the cached figure extractions in
 * `figures`. Both are keyed on (userId, informationSourceHash): the hash names
 * the content, the user id scopes it, matching how the source blob itself is now
 * stored.
 *
 * This class exists because neither collection is reachable from the
 * information-source row. Without it, deleting a source removed the row and the
 * blob but left the extracted text behind indefinitely, so the page text
 * outlived the document it came from — which would undercut both the retention
 * promise and any erasure request.
 *
 * Two purge shapes, and the distinction is deliberate:
 *
 *   - purgeForUserAndContentHash — the normal path. Removes one user's derived
 *     content and nothing else. Used by delete, expiry and account closure.
 *   - purgeByContentHash — crosses the tenant boundary on purpose. Used ONLY by
 *     the admin takedown path, where a rightsholder notice is about the content
 *     itself rather than about one account, and by orphan reconciliation.
 */
class DerivedContentQueryEngine
{
    /**
     * Removes the embedding chunks and cached figures one user derived from a
     * document. Safe to call when nothing matches.
     *
     * @param {string} userId - The owning user.
     * @param {string} contentHash - The sha512 of the source document.
     * @return {Promise<{embeddingChunksRemoved: number, figuresRemoved: number}>}
     */
    static async purgeForUserAndContentHash(userId, contentHash)
    {
        if (typeof userId !== "string" || userId.length === 0 || typeof contentHash !== "string" || contentHash.length === 0)
        {
            return { embeddingChunksRemoved: 0, figuresRemoved: 0 };
        }

        return await DerivedContentQueryEngine.#deleteMatching({ userId: userId, informationSourceHash: contentHash });
    }

    /**
     * Removes EVERY user's derived content for a document. This crosses the
     * tenant boundary by design — a takedown notice concerns the work, not one
     * account — so it must not be used on any user-initiated path.
     *
     * @param {string} contentHash - The sha512 of the source document.
     * @return {Promise<{embeddingChunksRemoved: number, figuresRemoved: number}>}
     */
    static async purgeByContentHash(contentHash)
    {
        if (typeof contentHash !== "string" || contentHash.length === 0)
        {
            return { embeddingChunksRemoved: 0, figuresRemoved: 0 };
        }

        return await DerivedContentQueryEngine.#deleteMatching({ informationSourceHash: contentHash });
    }

    static async #deleteMatching(filter)
    {
        const database = await DatabaseConnector.getDatabase();

        const embeddingDeletion = await database
            .collection(DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION)
            .deleteMany(filter);

        const figureDeletion = await database
            .collection(DatabaseConstants.FIGURES_COLLECTION)
            .deleteMany(filter);

        return {
            embeddingChunksRemoved: embeddingDeletion.deletedCount || 0,
            figuresRemoved: figureDeletion.deletedCount || 0
        };
    }

    /**
     * Finds (userId, hash) pairs that still have derived content but no
     * surviving information-source row — residue of a removal whose cascade did
     * not complete, or of content written before the cascade existed.
     *
     * Matching is on the PAIR, not the hash alone. With per-user storage the same
     * document can be held by several users independently, so a hash that still
     * exists for user B says nothing about whether user A's chunks are orphaned.
     * Checking the hash alone would silently leave A's content behind forever.
     *
     * @param {number} maximumPairsToInspect - Bound on the work done per sweep.
     * @return {Promise<Array<{userId: string, contentHash: string}>>}
     */
    static async findOrphanedDerivedContent(maximumPairsToInspect)
    {
        const database = await DatabaseConnector.getDatabase();

        const derivedPairs = await database
            .collection(DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION)
            .aggregate([
                { $group: { _id: { userId: "$userId", informationSourceHash: "$informationSourceHash" } } },
                { $limit: maximumPairsToInspect },
            ])
            .toArray();

        const candidatePairs = derivedPairs
            .map(derivedPair => ({ userId: derivedPair._id.userId, contentHash: derivedPair._id.informationSourceHash }))
            .filter(candidate => typeof candidate.contentHash === "string" && candidate.contentHash.length > 0);

        if (candidatePairs.length === 0)
        {
            return [];
        }

        const survivingDocuments = await database
            .collection(DatabaseConstants.INFORMATION_SOURCES_COLLECTION)
            .find(
                { hash: { $in: candidatePairs.map(candidate => candidate.contentHash) } },
                { projection: { _id: 0, userId: 1, hash: 1 } },
            ).toArray();

        const survivingKeys = new Set(survivingDocuments.map(document => `${document.userId}::${document.hash}`));

        return candidatePairs.filter(candidate => !survivingKeys.has(`${candidate.userId}::${candidate.contentHash}`));
    }

    /**
     * Counts the derived artefacts held for a document across all users. Used by
     * the takedown endpoint's dry run to report what a notice would affect.
     *
     * @param {string} contentHash - The sha512 of the source document.
     * @return {Promise<{embeddingChunks: number, figures: number}>}
     */
    static async countByContentHash(contentHash)
    {
        if (typeof contentHash !== "string" || contentHash.length === 0)
        {
            return { embeddingChunks: 0, figures: 0 };
        }

        const database = await DatabaseConnector.getDatabase();

        const embeddingChunks = await database
            .collection(DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION)
            .countDocuments({ informationSourceHash: contentHash });

        const figures = await database
            .collection(DatabaseConstants.FIGURES_COLLECTION)
            .countDocuments({ informationSourceHash: contentHash });

        return { embeddingChunks: embeddingChunks, figures: figures };
    }
}

module.exports = DerivedContentQueryEngine;
