const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

class DeckQueryEngine
{
    static #PROJECTION = { projection: { _id: 0 } };

    static async getDecksModifiedSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);
        const decks = await collection.find({ userId, "lifecycle.lastModified": { $gt: sinceDate } }, DeckQueryEngine.#PROJECTION).toArray();
        console.log(`[DeckQueryEngine] getDecksModifiedSince — found ${decks.length} deck(s) for user ${userId} since ${sinceDate.toISOString()}`);
        return decks;
    }

    static async getDeletionsSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);
        const deletions = await collection.find({ userId, entityType: "deck", deletedAt: { $gt: sinceDate } }, { projection: { _id: 0, entityId: 1 } }).toArray();
        return deletions.map(d => d.entityId);
    }

    static async upsertDeck(deckDocument)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const existingDeck = await collection.findOne({ id: deckDocument.id });
        const incomingLastModified = new Date(deckDocument.lifecycle.lastModified);

        if (existingDeck && new Date(existingDeck.lifecycle.lastModified) > incomingLastModified)
        {
            console.log(`[DeckQueryEngine] Skipping upsert for deck ${deckDocument.id} — server version is newer.`);
            return;
        }

        const normalizedDeck =
        {
            ...deckDocument,
            lifecycle:
            {
                ...deckDocument.lifecycle,
                creationDate: new Date(deckDocument.lifecycle.creationDate),
                lastModified: new Date(deckDocument.lifecycle.lastModified),
            }
        };

        await collection.updateOne(
            { id: normalizedDeck.id },
            { $set: normalizedDeck },
            { upsert: true }
        );

        console.log(`[DeckQueryEngine] Upserted deck ${deckDocument.id} (${deckDocument.name}).`);
    }

    static async deleteDeckIfNotModified(deckId, userId, clientLastSyncedAt)
    {
        const db = await DatabaseConnector.getDatabase();
        const collection = db.collection(DatabaseConstants.DECKS_COLLECTION);
        const deletionsCollection = db.collection(DatabaseConstants.DELETIONS_COLLECTION);

        const existingDeck = await collection.findOne({ id: deckId });

        if (!existingDeck)
        {
            console.log(`[DeckQueryEngine] Deck ${deckId} not found on server — nothing to delete.`);
            return false;
        }

        const sinceDate = clientLastSyncedAt instanceof Date ? clientLastSyncedAt : new Date(clientLastSyncedAt);

        if (new Date(existingDeck.lifecycle.lastModified) > sinceDate)
        {
            console.log(`[DeckQueryEngine] Skipping deletion of deck ${deckId} — modified after client last synced (modification wins).`);
            return false;
        }

        await collection.deleteOne({ id: deckId });

        // Write to deletions log so other devices learn about this deletion
        await deletionsCollection.insertOne({ userId, entityId: deckId, entityType: "deck", deletedAt: new Date() });

        console.log(`[DeckQueryEngine] Deleted deck ${deckId} and recorded in deletions log.`);
        return true;
    }
}

module.exports = DeckQueryEngine;