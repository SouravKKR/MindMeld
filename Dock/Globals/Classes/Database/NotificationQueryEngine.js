const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const NotificationRecord = require("../../Model/NotificationRecord");

/**
 * Persistence for in-app notifications (the notifications collection). Mirrors
 * the static-method / #getCollection / fail-soft style of the other query
 * engines. Rows auto-expire via the TTL index on createdAt
 * (NOTIFICATIONS_TTL_DAYS), so this engine never has to prune old rows itself.
 */
class NotificationQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.NOTIFICATIONS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(NotificationQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Persists one in-app notification. Returns { saved, notification } where
     * notification is the stored NotificationRecord (so the caller can echo its
     * id / createdAt).
     */
    static async insertNotification(notificationRecord)
    {
        const collection = await NotificationQueryEngine.#getCollection();
        if (!collection)
        {
            return { saved: false, notification: notificationRecord };
        }

        const document =
        {
            id: notificationRecord.getId(),
            userId: notificationRecord.getUserId(),
            type: notificationRecord.getType(),
            title: notificationRecord.getTitle(),
            body: notificationRecord.getBody(),
            data: notificationRecord.getData(),
            createdAt: notificationRecord.getCreatedAt(),
            readAt: notificationRecord.getReadAt()
        };

        await collection.insertOne(document);
        return { saved: true, notification: notificationRecord };
    }

    /**
     * Lists a user's notifications, newest first, capped at `limit`. Returns an
     * array of plain JSON objects (via NotificationRecord.toJson) ready for the
     * client.
     */
    static async listForUser(userId, limit)
    {
        const normalisedUserId = String(userId ?? "");
        if (!normalisedUserId)
        {
            return [];
        }

        const collection = await NotificationQueryEngine.#getCollection();
        if (!collection)
        {
            return [];
        }

        const cappedLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;

        const documents = await collection
            .find({ userId: normalisedUserId }, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .limit(cappedLimit)
            .toArray();

        return documents.map(document => NotificationRecord.fromJson(document).toJson());
    }

    /**
     * Bulk-inserts one in-app notification per user id from a shared content
     * template ({type, title, body, data}), for broadcasts. Each row gets its
     * own id + createdAt. Returns the number of rows inserted.
     */
    static async insertManyForUsers(userIds, contentTemplate)
    {
        if (!Array.isArray(userIds) || userIds.length === 0)
        {
            return 0;
        }

        const collection = await NotificationQueryEngine.#getCollection();
        if (!collection)
        {
            return 0;
        }

        const now = new Date();
        const documents = userIds
            .filter(userId => typeof userId === "string" && userId.length > 0)
            .map(userId =>
            {
                const record = new NotificationRecord
                ({
                    userId: userId,
                    type: contentTemplate?.type,
                    title: contentTemplate?.title,
                    body: contentTemplate?.body,
                    data: contentTemplate?.data,
                    createdAt: now,
                    readAt: null
                });
                return {
                    id: record.getId(),
                    userId: record.getUserId(),
                    type: record.getType(),
                    title: record.getTitle(),
                    body: record.getBody(),
                    data: record.getData(),
                    createdAt: record.getCreatedAt(),
                    readAt: record.getReadAt()
                };
            });

        if (documents.length === 0)
        {
            return 0;
        }

        const result = await collection.insertMany(documents, { ordered: false });
        return result.insertedCount || 0;
    }

    /**
     * Marks one of a user's notifications read. Scoped to the user so a client
     * can never mark another user's row. Returns { updated }.
     */
    static async markRead(userId, notificationId)
    {
        const normalisedUserId = String(userId ?? "");
        const normalisedId = String(notificationId ?? "");
        if (!normalisedUserId || !normalisedId)
        {
            return { updated: false };
        }

        const collection = await NotificationQueryEngine.#getCollection();
        if (!collection)
        {
            return { updated: false };
        }

        const result = await collection.updateOne
        (
            { userId: normalisedUserId, id: normalisedId },
            { $set: { readAt: new Date() } }
        );

        return { updated: result.matchedCount > 0 };
    }
}

module.exports = NotificationQueryEngine;
