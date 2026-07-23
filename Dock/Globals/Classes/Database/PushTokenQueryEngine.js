const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PushToken = require("../../Model/PushToken");

/**
 * Persistence for per-user device push tokens (the pushTokens collection).
 * Mirrors the static-method / #getCollection / fail-soft style of the other
 * query engines. One row per (userId, token); registering the same token again
 * just refreshes lastSeenAt.
 */
class PushTokenQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.PUSH_TOKENS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(PushTokenQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Upserts a token for a user. Registering an already-known token is
     * idempotent — only lastSeenAt is bumped. Returns { registered } where
     * registered is true on first insert.
     */
    static async registerToken(userId, token, platform)
    {
        const normalisedUserId = String(userId ?? "");
        const normalisedToken = String(token ?? "").trim();
        if (!normalisedUserId || !normalisedToken)
        {
            return { registered: false };
        }

        const collection = await PushTokenQueryEngine.#getCollection();
        if (!collection)
        {
            return { registered: false };
        }

        const record = new PushToken
        ({
            userId: normalisedUserId,
            token: normalisedToken,
            platform: platform,
            createdAt: new Date(),
            lastSeenAt: new Date()
        });

        const update =
        {
            $setOnInsert:
            {
                id: record.getId(),
                userId: record.getUserId(),
                token: record.getToken(),
                createdAt: record.getCreatedAt()
            },
            $set:
            {
                platform: record.getPlatform(),
                lastSeenAt: record.getLastSeenAt()
            }
        };

        const result = await collection.updateOne
        (
            { userId: normalisedUserId, token: normalisedToken },
            update,
            { upsert: true }
        );

        return { registered: result.upsertedCount > 0 };
    }

    /**
     * Removes a single token (e.g. on logout or when the client detects the
     * token rotated). Returns { removed }.
     */
    static async removeToken(userId, token)
    {
        const normalisedUserId = String(userId ?? "");
        const normalisedToken = String(token ?? "").trim();
        if (!normalisedUserId || !normalisedToken)
        {
            return { removed: false };
        }

        const collection = await PushTokenQueryEngine.#getCollection();
        if (!collection)
        {
            return { removed: false };
        }

        const result = await collection.deleteOne({ userId: normalisedUserId, token: normalisedToken });
        return { removed: result.deletedCount > 0 };
    }

    /**
     * Removes a set of tokens across all users. Called after a send to prune
     * tokens FCM reported as permanently invalid. Returns the deleted count.
     */
    static async removeTokens(tokens)
    {
        if (!Array.isArray(tokens) || tokens.length === 0)
        {
            return 0;
        }

        const collection = await PushTokenQueryEngine.#getCollection();
        if (!collection)
        {
            return 0;
        }

        const result = await collection.deleteMany({ token: { $in: tokens } });
        return result.deletedCount || 0;
    }

    /**
     * Returns every registration token string for a user (deduplicated by the
     * unique index). Empty array when the user has none or the DB is down.
     */
    static async listTokensForUser(userId)
    {
        const normalisedUserId = String(userId ?? "");
        if (!normalisedUserId)
        {
            return [];
        }

        const collection = await PushTokenQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const documents = await collection
            .find({ userId: normalisedUserId }, { projection: { _id: 0, token: 1 } })
            .toArray();

        return documents
            .map(document => document.token)
            .filter(token => typeof token === "string" && token.length > 0);
    }

    /**
     * Streams every registration token across ALL users to `batchHandler` in
     * chunks of `batchSize`, for broadcast pushes. Iterating a cursor keeps the
     * whole token set from being held in memory at once. Returns the total
     * number of tokens handed to the handler.
     */
    static async streamAllTokens(batchSize, batchHandler)
    {
        const collection = await PushTokenQueryEngine.#getCollection();
        if (!collection)
        {
            return 0;
        }

        const cappedBatchSize = Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500 ? batchSize : 500;
        const cursor = collection.find({}, { projection: { _id: 0, token: 1 } }).batchSize(cappedBatchSize);

        let totalHandled = 0;
        let currentBatch = [];

        for await (const document of cursor)
        {
            if (typeof document.token === "string" && document.token.length > 0)
            {
                currentBatch.push(document.token);
            }

            if (currentBatch.length >= cappedBatchSize)
            {
                await batchHandler(currentBatch);
                totalHandled = totalHandled + currentBatch.length;
                currentBatch = [];
            }
        }

        if (currentBatch.length > 0)
        {
            await batchHandler(currentBatch);
            totalHandled = totalHandled + currentBatch.length;
        }

        return totalHandled;
    }
}

module.exports = PushTokenQueryEngine;
