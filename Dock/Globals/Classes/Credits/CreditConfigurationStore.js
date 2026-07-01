const DatabaseConstants = require('../../Constants/DatabaseConstants');
const DatabaseConnector = require('../Database/DatabaseConnector');
const CreditConfiguration = require('./CreditConfiguration');

// Loads and persists the singleton credit configuration document
// (creditConfig._id == "global"). A short in-process cache keeps the
// per-task / per-sync read off MongoDB's hot path without making admin
// edits take noticeably long to apply.

class CreditConfigurationStore
{
    static #DOCUMENT_ID = "global";
    static #CACHE_TTL_MILLISECONDS = 15 * 1000;

    static #cachedConfiguration = null;
    static #cachedAtMilliseconds = 0;

    /**
     * Returns the current configuration, seeding and persisting a default
     * document on first ever read. Cached for a short window.
     * @returns {Promise<CreditConfiguration>}
     */
    static async load()
    {
        const now = Date.now();
        if (CreditConfigurationStore.#cachedConfiguration !== null && (now - CreditConfigurationStore.#cachedAtMilliseconds) < CreditConfigurationStore.#CACHE_TTL_MILLISECONDS)
        {
            return CreditConfigurationStore.#cachedConfiguration;
        }

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.CREDIT_CONFIG_COLLECTION);

        const document = await collection.findOne({ _id: CreditConfigurationStore.#DOCUMENT_ID });

        let configuration;
        if (document)
        {
            configuration = CreditConfiguration.fromJson(document);
        }
        else
        {
            configuration = new CreditConfiguration({});
        }

        // The AskAi tiers must never be silently free: an absent rule reads
        // as "unmetered" to CreditPreflight, so backfill the default rules
        // into both fresh and pre-existing configuration documents.
        const bAddedAskAiRules = configuration.ensureAskAiTaskRules();

        // Same reasoning for the Auto Fill Other Options helper — it also
        // bypasses the task queue and must carry a configured flat-cost rule.
        const bAddedAutoFillRule = configuration.ensureAutoFillGenerationOptionsTaskRule();

        if (!document || bAddedAskAiRules || bAddedAutoFillRule)
        {
            await collection.updateOne
            (
                { _id: CreditConfigurationStore.#DOCUMENT_ID },
                { $set: configuration.toJson() },
                { upsert: true }
            );
        }

        CreditConfigurationStore.#cachedConfiguration = configuration;
        CreditConfigurationStore.#cachedAtMilliseconds = now;
        return configuration;
    }

    /**
     * Persists a new configuration, bumping the version and stamping the
     * editor. Invalidates the cache so the next load reflects the change.
     * @param {CreditConfiguration} configuration
     * @param {string} updatedByUserId
     * @returns {Promise<CreditConfiguration>}
     */
    static async save(configuration, updatedByUserId)
    {
        configuration.setVersion(configuration.getVersion() + 1);
        configuration.setUpdatedAt(new Date());
        configuration.setUpdatedBy(updatedByUserId || '');

        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.CREDIT_CONFIG_COLLECTION);

        await collection.updateOne
        (
            { _id: CreditConfigurationStore.#DOCUMENT_ID },
            { $set: configuration.toJson() },
            { upsert: true }
        );

        CreditConfigurationStore.#cachedConfiguration = configuration;
        CreditConfigurationStore.#cachedAtMilliseconds = Date.now();
        return configuration;
    }

    static invalidateCache()
    {
        CreditConfigurationStore.#cachedConfiguration = null;
        CreditConfigurationStore.#cachedAtMilliseconds = 0;
    }
}

module.exports = CreditConfigurationStore;
