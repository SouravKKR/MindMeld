const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");

/**
 * Removes the partialCompletion marker from the given decks. Used after a
 * successful "retry the rest" run so the incomplete-generation badge disappears
 * even when the retry produced no new deck rows for the deck-upsert pass to
 * touch — e.g. a mock-tests-only retry that just attaches a bundle to an
 * existing deck and therefore builds an empty deck hierarchy.
 *
 * Bumps lifecycle.lastModified so the cleared additionalData wins
 * SyncQueryEngine.upsertDeck's newer-wins guard and reaches the client on the
 * next sync. Idempotent — decks without the marker (or that no longer exist)
 * are skipped.
 *
 * @param {string} userId
 * @param {string[]} deckIds
 */
async function clearPartialCompletionOnDecks(userId, deckIds)
{
    if (!Array.isArray(deckIds) || deckIds.length === 0)
    {
        return;
    }

    const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
    const now = new Date().toISOString();

    for (const deckId of deckIds)
    {
        const existing = await collection.findOne({ userId: userId, "data.id": deckId }, { projection: { _id: 0, data: 1 } });
        if (!existing || !existing.data)
        {
            continue;
        }

        const deckData = existing.data;
        if (!deckData.additionalData || !deckData.additionalData.partialCompletion)
        {
            continue;
        }

        const clearedAdditionalData = { ...deckData.additionalData };
        delete clearedAdditionalData.partialCompletion;
        deckData.additionalData = clearedAdditionalData;

        deckData.lifecycle = { ...(deckData.lifecycle || {}), lastModified: now };

        await SyncQueryEngine.upsertDeck(userId, deckData);
    }
}

module.exports = { clearPartialCompletionOnDecks };
