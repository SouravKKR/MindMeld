const ContentTakedownNoticeQueryEngine = require("../Database/ContentTakedownNoticeQueryEngine");
const EmbeddedFigureStripper = require("./EmbeddedFigureStripper");

/**
 * TakenDownFigureGuard
 *
 * Strips figures belonging to already-taken-down documents out of entities
 * arriving on the sync push path, before they are written.
 *
 * Why this is necessary. EmbeddedFigurePurger removes the embedded copies that
 * exist at the moment a notice is actioned, and the rewrite propagates to every
 * device on its next pull. It cannot reach a device that was OFFLINE at the
 * time. That device still holds the figure, and the moment it reconnects it
 * pushes its own copy with a newer lifecycle.lastModified — which the
 * last-write-wins upsert accepts, putting the artwork back on the server and
 * from there onto every other device. The takedown would silently undo itself,
 * and the register would still say the content was removed.
 *
 * So the removal has to be enforced at ingress as well as applied once. The
 * takedown register is insert-only, which makes it a durable list of every hash
 * that must never be re-accepted; this guard is that list applied to writes.
 *
 * Cost. The hash set is cached in process, and the overwhelmingly common case
 * is that it is EMPTY — a deployment with no notices actioned pays one
 * boolean check per sync push and nothing else. When it is non-empty the check
 * is a substring test per entity, which is the same test the purger uses.
 *
 * The cache is time-bounded rather than event-driven because Dock runs as more
 * than one process: an invalidation in the process that served the takedown
 * would not reach the others, so the TTL is what bounds the window everywhere.
 * The endpoint that actions a notice also invalidates its own copy, which makes
 * the common single-process case immediate rather than eventually correct.
 */
class TakenDownFigureGuard
{
    static #CACHE_LIFETIME_MILLISECONDS = 5 * 60 * 1000;
    static #CARD_HTML_FIELD_NAMES = ["question", "answer"];

    static #cachedContentHashes = null;
    static #cacheExpiresAtMilliseconds = 0;

    /**
     * Removes taken-down figures from a batch of incoming study materials.
     * Returns the same array; entries are rewritten in place so the caller's
     * ordering and grouping are untouched.
     *
     * @param {object[]} studyMaterialDataArray
     * @return {Promise<{sanitizedEntityCount: number, figuresStripped: number}>}
     */
    static async sanitizeStudyMaterials(studyMaterialDataArray)
    {
        const outcome = { sanitizedEntityCount: 0, figuresStripped: 0 };

        if (!Array.isArray(studyMaterialDataArray) || studyMaterialDataArray.length === 0)
        {
            return outcome;
        }

        const takenDownHashes = await TakenDownFigureGuard.#getTakenDownHashes();

        if (takenDownHashes.size === 0)
        {
            return outcome;
        }

        for (const studyMaterialData of studyMaterialDataArray)
        {
            if (typeof studyMaterialData?.content !== "string")
            {
                continue;
            }

            const strippedFigureCount = TakenDownFigureGuard.#stripField(studyMaterialData, "content", takenDownHashes);

            if (strippedFigureCount > 0)
            {
                outcome.sanitizedEntityCount++;
                outcome.figuresStripped += strippedFigureCount;
            }
        }

        return outcome;
    }

    /**
     * Removes taken-down figures from a batch of incoming cards.
     *
     * @param {object[]} cardDataArray
     * @return {Promise<{sanitizedEntityCount: number, figuresStripped: number}>}
     */
    static async sanitizeCards(cardDataArray)
    {
        const outcome = { sanitizedEntityCount: 0, figuresStripped: 0 };

        if (!Array.isArray(cardDataArray) || cardDataArray.length === 0)
        {
            return outcome;
        }

        const takenDownHashes = await TakenDownFigureGuard.#getTakenDownHashes();

        if (takenDownHashes.size === 0)
        {
            return outcome;
        }

        for (const cardData of cardDataArray)
        {
            let strippedFigureCount = 0;

            for (const fieldName of TakenDownFigureGuard.#CARD_HTML_FIELD_NAMES)
            {
                if (typeof cardData?.[fieldName] !== "string")
                {
                    continue;
                }

                strippedFigureCount += TakenDownFigureGuard.#stripField(cardData, fieldName, takenDownHashes);
            }

            if (strippedFigureCount > 0)
            {
                outcome.sanitizedEntityCount++;
                outcome.figuresStripped += strippedFigureCount;
            }
        }

        return outcome;
    }

    /**
     * Drops the cached hash set so the next call re-reads the register. Called
     * by the takedown endpoint so a freshly actioned notice is enforced on the
     * very next push in this process rather than after the TTL.
     */
    static invalidateCache()
    {
        TakenDownFigureGuard.#cachedContentHashes = null;
        TakenDownFigureGuard.#cacheExpiresAtMilliseconds = 0;
    }

    static #stripField(entityData, fieldName, takenDownHashes)
    {
        let strippedFigureCount = 0;

        for (const takenDownHash of takenDownHashes)
        {
            if (!EmbeddedFigureStripper.containsSourceHash(entityData[fieldName], takenDownHash))
            {
                continue;
            }

            const stripResult = EmbeddedFigureStripper.strip(entityData[fieldName], takenDownHash);
            entityData[fieldName] = stripResult.html;
            strippedFigureCount += stripResult.removedCount;
        }

        return strippedFigureCount;
    }

    static async #getTakenDownHashes()
    {
        const nowMilliseconds = Date.now();

        if (TakenDownFigureGuard.#cachedContentHashes !== null && nowMilliseconds < TakenDownFigureGuard.#cacheExpiresAtMilliseconds)
        {
            return TakenDownFigureGuard.#cachedContentHashes;
        }

        try
        {
            const contentHashes = await ContentTakedownNoticeQueryEngine.getAllContentHashes();
            TakenDownFigureGuard.#cachedContentHashes = new Set(contentHashes);
            TakenDownFigureGuard.#cacheExpiresAtMilliseconds = nowMilliseconds + TakenDownFigureGuard.#CACHE_LIFETIME_MILLISECONDS;
        }
        catch (registerError)
        {
            // Fail OPEN, and say so. Failing closed would mean refusing every
            // sync push because the register could not be read, which trades a
            // narrow re-infection window for a total outage. The window is
            // already covered by the periodic re-apply script; an outage is not
            // recoverable by anything.
            console.warn(`[TakenDownFigureGuard] Could not read the takedown register, allowing this push through: ${registerError?.message || registerError}`);
            TakenDownFigureGuard.#cachedContentHashes = new Set();
            TakenDownFigureGuard.#cacheExpiresAtMilliseconds = 0;
        }

        return TakenDownFigureGuard.#cachedContentHashes;
    }
}

module.exports = TakenDownFigureGuard;
