const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * Read/write engine for `legalDocuments` — the small set of versioned
 * HTML documents (Terms of Service, Privacy Policy) that every
 * authenticated user sees on login when a newer version has been seeded.
 *
 * Writes are limited to the seeder path (upsertVersioned). The user-
 * facing endpoint only ever reads.
 */
class LegalDocumentQueryEngine
{
    static #PUBLIC_PROJECTION =
    {
        projection:
        {
            _id: 0,
            key: 1,
            title: 1,
            version: 1,
            contentHtml: 1
        }
    };

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(DatabaseConstants.LEGAL_DOCUMENTS_COLLECTION);
    }

    /**
     * Returns every legal document. The set is small (two entries today),
     * so the caller — typically the post-login client — fetches all of
     * them in one round-trip and decides per document whether to surface
     * the popup based on the user's stored agreed-version.
     *
     * @returns {Promise<Array<{key:string,title:string,version:number,contentHtml:string}>>}
     */
    static async getAll()
    {
        const collection = await LegalDocumentQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }
        return await collection
            .find({}, LegalDocumentQueryEngine.#PUBLIC_PROJECTION)
            .toArray();
    }

    /**
     * Version-aware upsert: when no document with this key exists, inserts
     * the seed verbatim. When one exists with a STRICTLY LOWER version,
     * overwrites `title`, `contentHtml`, and `version`. When the stored
     * version is equal or higher, leaves the document untouched so admin
     * hand-edits at the same version survive boot. Always updates
     * `updatedAt` so operators can see when a doc was last touched.
     *
     * @param {object} seedDocument Must contain key (string), title (string), version (number), contentHtml (string).
     * @returns {Promise<{inserted: boolean, upgraded: boolean}>}
     */
    static async upsertVersioned(seedDocument)
    {
        const collection = await LegalDocumentQueryEngine.#getCollection();
        if (!collection)
        {
            return { inserted: false, upgraded: false };
        }

        const seedKey = seedDocument.key;
        const seedVersion = Number(seedDocument.version);

        const existingDocument = await collection.findOne({ key: seedKey });

        if (!existingDocument)
        {
            await collection.insertOne(
            {
                key:         seedKey,
                title:       seedDocument.title,
                version:     seedVersion,
                contentHtml: seedDocument.contentHtml,
                updatedAt:   new Date()
            });
            return { inserted: true, upgraded: false };
        }

        const storedVersion = Number(existingDocument.version || 0);

        if (seedVersion > storedVersion)
        {
            await collection.updateOne(
                { key: seedKey },
                {
                    $set:
                    {
                        title:       seedDocument.title,
                        version:     seedVersion,
                        contentHtml: seedDocument.contentHtml,
                        updatedAt:   new Date()
                    }
                }
            );
            return { inserted: false, upgraded: true };
        }

        return { inserted: false, upgraded: false };
    }

    /**
     * Deletes every legal document whose key is NOT in `keepKeys`. Called
     * by the seeder after upserts so a key that disappears from
     * Dock/SeedData/LegalDocuments.json (e.g. a retired EULA) is also
     * cleaned out of Mongo on the next boot — otherwise stale documents
     * would keep showing up in the user-facing agreement modal forever.
     *
     * @param {string[]} keepKeys
     * @returns {Promise<number>} Number of documents removed.
     */
    static async pruneKeysNotIn(keepKeys)
    {
        const collection = await LegalDocumentQueryEngine.#getCollection();
        if (!collection)
        {
            return 0;
        }

        const sanitizedKeepKeys = Array.isArray(keepKeys)
            ? keepKeys.filter(keepKey => typeof keepKey === "string" && keepKey.length > 0)
            : [];

        const deleteResult = await collection.deleteMany({ key: { $nin: sanitizedKeepKeys } });
        return deleteResult.deletedCount || 0;
    }
}

module.exports = LegalDocumentQueryEngine;
