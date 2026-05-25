const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * Query engine for the curated generation-template collection.
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
 * The only write path is `upsertFromSeed`, invoked at boot by
 * `GenerationTemplateSeeder`. The seed file at
 * `Dock/SeedData/GenerationTemplates.json` is the source of truth: every
 * template is replaced from the seed on every Dock boot, so the in-app
 * UI always reflects whatever is in the JSON. Manual edits to seeded
 * keys via the Mongo shell will be clobbered on the next restart — to
 * persist an admin override, also update the seed file.
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
     * Replaces the document for `(userId, templateKey)` with the seed
     * payload, inserting it if it does not yet exist. The boot-time
     * seeder calls this once per entry in the seed JSON, so the on-disk
     * file is the source of truth: every Dock boot brings the database
     * back into agreement with `Dock/SeedData/GenerationTemplates.json`.
     * Manual admin edits to seeded keys are clobbered on the next
     * restart — to make an admin override stick, also update the seed
     * file.
     *
     * `replaceOne` with `upsert: true` preserves the existing document's
     * `_id` on a match, so the picker's lookup-by-key and any external
     * references via `_id` remain stable across reseeds. `seededAt` is
     * refreshed to the current time on every call so operators can audit
     * the most recent reseed.
     *
     * Global templates are stored with `userId: null` so the composite
     * `{userId:1, key:1}` filter keys cleanly without relying on
     * MongoDB's partial-index semantics.
     *
     * @param {string} templateKey
     * @param {object} templateData
     * @returns {Promise<{inserted: boolean, updated: boolean}>} inserted=true on a fresh insert, updated=true when an existing document was replaced.
     */
    static async upsertFromSeed(templateKey, templateData)
    {
        if (!templateKey || typeof templateKey !== "string")
        {
            return { inserted: false, updated: false };
        }

        const collection = await GenerationTemplateQueryEngine.#getCollection();
        if (!collection)
        {
            return { inserted: false, updated: false };
        }

        const ownerId = templateData && templateData.userId ? templateData.userId : null;

        // replaceOne errors if the replacement carries an `_id` that
        // differs from the matched document's, so we strip any incoming
        // `_id` to keep the call shape-compatible whether the document
        // is being inserted fresh or replaced in place.
        const replacementDocument =
        {
            ...templateData,
            key: templateKey,
            userId: ownerId,
            seededAt: new Date()
        };
        delete replacementDocument._id;

        const result = await collection.replaceOne(
            { key: templateKey, userId: ownerId },
            replacementDocument,
            { upsert: true }
        );

        return {
            inserted: result.upsertedCount > 0,
            updated: result.matchedCount > 0
        };
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
