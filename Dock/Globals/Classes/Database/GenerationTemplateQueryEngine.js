const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * Read-only query engine for the curated generation-template collection.
 *
 * The collection is keyed by `key` (the stable string identifier, e.g.
 * "JEE_MAINS"). Two indices back the queries:
 *   - { key: 1 } unique  → constant-time get-by-key
 *   - { displayName: "text", tagline: "text" } → search-as-you-type
 *
 * Search results carry only the minimal card payload (key, displayName,
 * tagline) so the picker can scale to hundreds of templates without
 * shipping their full settings to the client. The full template document
 * is fetched on selection via `getByKey`.
 *
 * Writes are intentionally not exposed here — the collection is seeded
 * from `Dock/SeedData/GenerationTemplates.json` on startup and is not
 * mutable through the application. New templates land by adding them to
 * the seed file and restarting Dock.
 */
class GenerationTemplateQueryEngine
{
    // The picker is paged at 20 by design — the user reads a short list
    // and refines via the search box rather than scrolling endlessly. The
    // hard cap stops a misbehaving client from asking for a thousand rows.
    static DEFAULT_SEARCH_LIMIT = 20;
    static MAX_SEARCH_LIMIT = 20;

    static #CARD_PROJECTION =
    {
        projection:
        {
            _id: 0,
            key: 1,
            displayName: 1,
            tagline: 1
        }
    };

    static #FULL_PROJECTION =
    {
        projection: { _id: 0 }
    };

    /**
     * Resolves the live Mongo collection handle, or returns null when the
     * database connection is unavailable. Every public method below checks
     * for null and bails out cleanly so a transient Mongo outage degrades
     * to "no templates available" instead of cascading null-deref errors.
     */
    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(DatabaseConstants.GENERATION_TEMPLATES_COLLECTION);
    }

    /**
     * Visibility matcher: the caller sees globals (no userId) PLUS any
     * template explicitly scoped to them. Folded into every read query
     * so listing and lookup share the exact same scoping rule.
     */
    static #buildVisibilityMatcher(userId)
    {
        return {
            $or:
            [
                { userId: { $exists: false } },
                { userId: null },
                { userId: userId }
            ]
        };
    }

    /**
     * Returns up to `limit` template cards in natural collection order —
     * effectively "whichever ones Mongo hands us first". Used to populate
     * the picker before the user types anything. No explicit sort: the
     * user can search to find a specific exam; the initial load is just a
     * sampling so the dialog isn't empty.
     *
     * @param {string} userId Identifies the calling user — globals plus their own templates are returned.
     * @param {number} limit
     * @returns {Promise<Array<{key: string, displayName: string, tagline: string}>>}
     */
    static async getTopCards(userId, limit = GenerationTemplateQueryEngine.DEFAULT_SEARCH_LIMIT)
    {
        const collection = await GenerationTemplateQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }
        const clampedLimit = GenerationTemplateQueryEngine.#clampLimit(limit);

        return await collection
            .find(
                GenerationTemplateQueryEngine.#buildVisibilityMatcher(userId),
                GenerationTemplateQueryEngine.#CARD_PROJECTION
            )
            .limit(clampedLimit)
            .toArray();
    }

    /**
     * Searches templates by displayName + tagline using a case-insensitive
     * regex. Scoped to globals plus the caller's own templates.
     *
     * @param {string} userId Identifies the calling user.
     * @param {string} query Free-form search string.
     * @param {number} limit
     * @returns {Promise<Array<{key: string, displayName: string, tagline: string}>>}
     */
    static async searchCards(userId, query, limit = GenerationTemplateQueryEngine.DEFAULT_SEARCH_LIMIT)
    {
        const trimmedQuery = (query || "").trim();
        if (trimmedQuery.length === 0)
        {
            return await GenerationTemplateQueryEngine.getTopCards(userId, limit);
        }

        const collection = await GenerationTemplateQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }
        const clampedLimit = GenerationTemplateQueryEngine.#clampLimit(limit);

        const escapedQuery = GenerationTemplateQueryEngine.#escapeRegex(trimmedQuery);
        const regexMatcher = new RegExp(escapedQuery, "i");

        const matchingDocuments = await collection
            .find(
                {
                    $and:
                    [
                        GenerationTemplateQueryEngine.#buildVisibilityMatcher(userId),
                        {
                            $or:
                            [
                                { displayName: regexMatcher },
                                { tagline: regexMatcher }
                            ]
                        }
                    ]
                },
                GenerationTemplateQueryEngine.#CARD_PROJECTION
            )
            .sort({ displayName: 1 })
            .limit(clampedLimit)
            .toArray();

        return matchingDocuments;
    }

    /**
     * Loads the full template document by key. Returns null when no
     * template matches under the visibility rules — i.e. the key exists
     * but is owned by another user.
     *
     * @param {string} userId Identifies the calling user.
     * @param {string} templateKey
     * @returns {Promise<object | null>}
     */
    static async getByKey(userId, templateKey)
    {
        if (!templateKey || typeof templateKey !== "string")
        {
            return null;
        }

        const collection = await GenerationTemplateQueryEngine.#getCollection();
        if (!collection)
        {
            return null;
        }
        return await collection.findOne(
            {
                $and:
                [
                    GenerationTemplateQueryEngine.#buildVisibilityMatcher(userId),
                    { key: templateKey }
                ]
            },
            GenerationTemplateQueryEngine.#FULL_PROJECTION
        );
    }

    /**
     * Inserts a template if (and only if) no document with the same
     * (userId, key) pair already exists. Used by the boot-time seeder:
     * existing templates — including ones an admin may have hand-edited
     * via the Mongo shell — are intentionally left untouched. The
     * `seededAt` timestamp marks the insertion time so operators can audit
     * which entries came from the seed file and when.
     *
     * Global templates are stored with `userId: null` so the composite
     * `{userId:1, key:1}` unique index keys cleanly without relying on
     * MongoDB's partial-index semantics.
     *
     * @param {string} templateKey
     * @param {object} templateData
     * @returns {Promise<boolean>} true if the template was newly inserted, false if a record with the same (userId, key) already existed.
     */
    static async insertIfMissing(templateKey, templateData)
    {
        if (!templateKey || typeof templateKey !== "string")
        {
            return false;
        }

        const collection = await GenerationTemplateQueryEngine.#getCollection();
        if (!collection)
        {
            return false;
        }

        const ownerId = templateData && templateData.userId ? templateData.userId : null;

        const result = await collection.updateOne(
            { key: templateKey, userId: ownerId },
            {
                $setOnInsert:
                {
                    ...templateData,
                    key: templateKey,
                    userId: ownerId,
                    seededAt: new Date()
                }
            },
            { upsert: true }
        );

        return result.upsertedCount > 0;
    }

    static #clampLimit(rawLimit)
    {
        const numericLimit = parseInt(rawLimit, 10);
        if (!Number.isFinite(numericLimit) || numericLimit <= 0)
        {
            return GenerationTemplateQueryEngine.DEFAULT_SEARCH_LIMIT;
        }
        return Math.min(numericLimit, GenerationTemplateQueryEngine.MAX_SEARCH_LIMIT);
    }

    static #escapeRegex(rawString)
    {
        return rawString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
}

module.exports = GenerationTemplateQueryEngine;
