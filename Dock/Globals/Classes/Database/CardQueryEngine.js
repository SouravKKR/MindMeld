const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

class CardQueryEngine
{
    static #PROJECTION = { projection: { _id: 0 } };

    static async getCardsModifiedSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);
        const cards = await collection.find({ userId, "lifecycle.lastModified": { $gt: sinceDate } }, CardQueryEngine.#PROJECTION).toArray();
        console.log(`[CardQueryEngine] getCardsModifiedSince — found ${cards.length} card(s) for user ${userId} since ${sinceDate.toISOString()}`);
        return cards;
    }

    static async getCardsWithProgressUpdatedSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);
        const cards = await collection.find({ userId, progressLastReview: { $gt: sinceDate } }, CardQueryEngine.#PROJECTION).toArray();
        console.log(`[CardQueryEngine] getCardsWithProgressUpdatedSince — found ${cards.length} card(s) for user ${userId} since ${sinceDate.toISOString()}`);
        return cards;
    }

    static async getDeletionsSince(userId, since)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DELETIONS_COLLECTION);
        const sinceDate = since instanceof Date ? since : new Date(since);
        const deletions = await collection.find({ userId, entityType: "card", deletedAt: { $gt: sinceDate } }, { projection: { _id: 0, entityId: 1 } }).toArray();
        return deletions.map(d => d.entityId);
    }

    static async upsertCardContent(cardDocument)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);

        const existingCard = await collection.findOne({ id: cardDocument.id });
        const incomingLastModified = new Date(cardDocument.lifecycle.lastModified);

        if (existingCard && new Date(existingCard.lifecycle.lastModified) > incomingLastModified)
        {
            console.log(`[CardQueryEngine] Skipping upsert for card ${cardDocument.id} — server version is newer.`);
            return;
        }

        const normalizedCard =
        {
            ...cardDocument,
            lifecycle:
            {
                ...cardDocument.lifecycle,
                creationDate: new Date(cardDocument.lifecycle.creationDate),
                lastModified: new Date(cardDocument.lifecycle.lastModified),
            },
            progressLastReview: cardDocument.progressLastReview ? new Date(cardDocument.progressLastReview) : null,
        };

        await collection.updateOne(
            { id: normalizedCard.id },
            { $set: normalizedCard },
            { upsert: true }
        );

        console.log(`[CardQueryEngine] Upserted card content ${cardDocument.id}.`);
    }

    static async upsertCardProgress(cardId, progress, progressLastReview)
    {
        const collection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);

        const existingCard = await collection.findOne({ id: cardId });

        if (!existingCard)
        {
            console.warn(`[CardQueryEngine] Card ${cardId} not found — cannot upsert progress.`);
            return;
        }

        const incomingReview = new Date(progressLastReview);

        if (existingCard.progressLastReview && new Date(existingCard.progressLastReview) > incomingReview)
        {
            console.log(`[CardQueryEngine] Skipping progress upsert for card ${cardId} — server progress is newer.`);
            return;
        }

        await collection.updateOne(
            { id: cardId },
            { $set: { progress, progressLastReview: incomingReview } }
        );

        console.log(`[CardQueryEngine] Upserted progress for card ${cardId}.`);
    }

    static async deleteCardIfNotModified(cardId, userId, clientLastSyncedAt)
    {
        const db = await DatabaseConnector.getDatabase();
        const collection = db.collection(DatabaseConstants.CARDS_COLLECTION);
        const deletionsCollection = db.collection(DatabaseConstants.DELETIONS_COLLECTION);

        const existingCard = await collection.findOne({ id: cardId });

        if (!existingCard)
        {
            console.log(`[CardQueryEngine] Card ${cardId} not found on server — nothing to delete.`);
            return false;
        }

        const sinceDate = clientLastSyncedAt instanceof Date ? clientLastSyncedAt : new Date(clientLastSyncedAt);

        if (new Date(existingCard.lifecycle.lastModified) > sinceDate)
        {
            console.log(`[CardQueryEngine] Skipping deletion of card ${cardId} — modified after client last synced (modification wins).`);
            return false;
        }

        await collection.deleteOne({ id: cardId });

        // Write to deletions log so other devices learn about this deletion
        await deletionsCollection.insertOne({ userId, entityId: cardId, entityType: "card", deletedAt: new Date() });

        console.log(`[CardQueryEngine] Deleted card ${cardId} and recorded in deletions log.`);
        return true;
    }
}

module.exports = CardQueryEngine;