const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const NotificationQueryEngine = require("../Database/NotificationQueryEngine");
const PushTokenQueryEngine = require("../Database/PushTokenQueryEngine");
const FirebaseMessagingClient = require("./FirebaseMessagingClient");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");

/**
 * Fan-out layer for notifications that go to EVERY user (announcements,
 * maintenance warnings). The per-user NotificationDispatcher cannot address
 * "all users", so broadcasts come here instead. Same bitwise channel model:
 *
 *   NotificationBroadcaster.broadcastToAllUsers(
 *       { type, title, body, data },
 *       notificationChannels.IN_APP | notificationChannels.PUSH);
 *
 *   - IN_APP → one persisted NotificationRecord per user (streamed in batches).
 *   - PUSH   → one FCM push to every registered device token (streamed in
 *              batches of 500), pruning tokens FCM rejects.
 *
 * Both channels stream via cursors so the whole user / token set is never held
 * in memory at once. Delivery problems are reported, never thrown.
 */
class NotificationBroadcaster
{
    static #USER_BATCH_SIZE = 500;
    static #TOKEN_BATCH_SIZE = 500;

    static #hasChannel(channelFlags, channel)
    {
        return (channelFlags & channel) === channel;
    }

    static async broadcastToAllUsers(notification, channelFlags)
    {
        const flags = Number.isInteger(channelFlags) ? channelFlags : notificationChannels.IN_APP;

        const outcome =
        {
            inApp: { delivered: false, recipientCount: 0 },
            push: { attempted: false, delivered: false, successCount: 0, failureCount: 0, tokenCount: 0, reason: null }
        };

        if (NotificationBroadcaster.#hasChannel(flags, notificationChannels.IN_APP))
        {
            outcome.inApp.recipientCount = await NotificationBroadcaster.#broadcastInApp(notification);
            outcome.inApp.delivered = outcome.inApp.recipientCount > 0;
        }

        if (NotificationBroadcaster.#hasChannel(flags, notificationChannels.PUSH))
        {
            outcome.push.attempted = true;

            if (!FirebaseMessagingClient.isConfigured())
            {
                outcome.push.reason = "FCM_NOT_CONFIGURED";
            }
            else
            {
                await NotificationBroadcaster.#broadcastPush(notification, outcome.push);
                outcome.push.delivered = outcome.push.successCount > 0;
            }
        }

        return outcome;
    }

    /**
     * Persists one in-app notification per user, streaming user ids in batches
     * so a large user base is never fully materialised. Returns the number of
     * recipients written.
     */
    static async #broadcastInApp(notification)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return 0;
        }

        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
        const cursor = usersCollection
            .find({}, { projection: { _id: 0, id: 1 } })
            .batchSize(NotificationBroadcaster.#USER_BATCH_SIZE);

        let totalRecipients = 0;
        let currentBatch = [];

        for await (const document of cursor)
        {
            if (typeof document.id === "string" && document.id.length > 0)
            {
                currentBatch.push(document.id);
            }

            if (currentBatch.length >= NotificationBroadcaster.#USER_BATCH_SIZE)
            {
                totalRecipients = totalRecipients + await NotificationQueryEngine.insertManyForUsers(currentBatch, notification);
                currentBatch = [];
            }
        }

        if (currentBatch.length > 0)
        {
            totalRecipients = totalRecipients + await NotificationQueryEngine.insertManyForUsers(currentBatch, notification);
        }

        return totalRecipients;
    }

    /**
     * Sends the push to every registered token in batches, accumulating counts
     * on the passed-in pushOutcome and pruning tokens FCM reports invalid.
     */
    static async #broadcastPush(notification, pushOutcome)
    {
        const invalidTokens = [];

        pushOutcome.tokenCount = await PushTokenQueryEngine.streamAllTokens
        (
            NotificationBroadcaster.#TOKEN_BATCH_SIZE,
            async (tokenBatch) =>
            {
                try
                {
                    const sendResult = await FirebaseMessagingClient.sendToTokens(tokenBatch, notification.title, notification.body, notification.data);
                    pushOutcome.successCount = pushOutcome.successCount + sendResult.successCount;
                    pushOutcome.failureCount = pushOutcome.failureCount + sendResult.failureCount;
                    for (const invalidToken of sendResult.invalidTokens)
                    {
                        invalidTokens.push(invalidToken);
                    }
                }
                catch (sendError)
                {
                    pushOutcome.reason = "SEND_FAILED";
                    console.warn(`[NotificationBroadcaster] FCM batch send failed: ${sendError.message}`);
                }
            }
        );

        if (invalidTokens.length > 0)
        {
            await PushTokenQueryEngine.removeTokens(invalidTokens);
        }
    }
}

module.exports = NotificationBroadcaster;
