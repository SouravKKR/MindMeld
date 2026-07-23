const NotificationRecord = require("../../Model/NotificationRecord");
const NotificationQueryEngine = require("../Database/NotificationQueryEngine");
const PushTokenQueryEngine = require("../Database/PushTokenQueryEngine");
const FirebaseMessagingClient = require("./FirebaseMessagingClient");
const { notificationChannels } = require("../../Enumerations/NotificationChannels");
const { notificationTypes } = require("../../Enumerations/NotificationTypes");

/**
 * The single entry point for raising a user notification. Callers choose the
 * delivery channels with a bitwise OR of NotificationChannels flags:
 *
 *     NotificationDispatcher.dispatch(userId,
 *         { type, title, body, data },
 *         notificationChannels.IN_APP | notificationChannels.PUSH);
 *
 *   - IN_APP  → persist a NotificationRecord the client fetches + renders.
 *   - PUSH    → send an FCM push to every registered device token for the user
 *               (works when the app is closed), pruning tokens FCM rejects.
 *
 * Both bits together deliver in-app AND push; either alone delivers just that
 * one. A requested channel that is unavailable (e.g. PUSH before the FCM keys
 * are configured) is skipped gracefully — the dispatch never throws for a
 * delivery problem, it reports per-channel outcomes in the returned object.
 */
class NotificationDispatcher
{
    // Convenient defaults for common call sites.
    static IN_APP_ONLY = notificationChannels.IN_APP;
    static PUSH_ONLY = notificationChannels.PUSH;
    static IN_APP_AND_PUSH = notificationChannels.IN_APP | notificationChannels.PUSH;

    static #hasChannel(channelFlags, channel)
    {
        return (channelFlags & channel) === channel;
    }

    /**
     * @param {string} userId
     * @param {{type?:number, title?:string, body?:string, data?:object}} notification
     * @param {number} channelFlags  bitwise OR of notificationChannels members
     * @returns {Promise<{inApp:{delivered:boolean, notificationId:(string|null)}, push:{delivered:boolean, attempted:boolean, successCount:number, failureCount:number, reason:(string|null)}}>}
     */
    static async dispatch(userId, notification, channelFlags)
    {
        const normalisedUserId = String(userId ?? "");
        const type = Number.isInteger(notification?.type) ? notification.type : notificationTypes.SYSTEM;
        const title = String(notification?.title ?? "");
        const body = String(notification?.body ?? "");
        const data = (notification?.data !== null && typeof notification?.data === "object") ? notification.data : {};
        const flags = Number.isInteger(channelFlags) ? channelFlags : NotificationDispatcher.IN_APP_ONLY;

        const outcome =
        {
            inApp: { delivered: false, notificationId: null },
            push: { delivered: false, attempted: false, successCount: 0, failureCount: 0, reason: null }
        };

        if (!normalisedUserId)
        {
            outcome.push.reason = "NO_USER";
            return outcome;
        }

        // ── IN_APP channel ───────────────────────────────────────────────────
        if (NotificationDispatcher.#hasChannel(flags, notificationChannels.IN_APP))
        {
            const record = new NotificationRecord
            ({
                userId: normalisedUserId,
                type: type,
                title: title,
                body: body,
                data: data,
                createdAt: new Date(),
                readAt: null
            });

            const insertResult = await NotificationQueryEngine.insertNotification(record);
            outcome.inApp.delivered = insertResult.saved;
            outcome.inApp.notificationId = insertResult.saved ? record.getId() : null;
        }

        // ── PUSH channel ─────────────────────────────────────────────────────
        if (NotificationDispatcher.#hasChannel(flags, notificationChannels.PUSH))
        {
            outcome.push.attempted = true;

            if (!FirebaseMessagingClient.isConfigured())
            {
                // No FCM keys yet — degrade gracefully instead of throwing so
                // callers can safely request PUSH before the keys are provided.
                outcome.push.reason = "FCM_NOT_CONFIGURED";
            }
            else
            {
                const tokens = await PushTokenQueryEngine.listTokensForUser(normalisedUserId);
                if (tokens.length === 0)
                {
                    outcome.push.reason = "NO_TOKENS";
                }
                else
                {
                    try
                    {
                        const sendResult = await FirebaseMessagingClient.sendToTokens(tokens, title, body, data);
                        outcome.push.successCount = sendResult.successCount;
                        outcome.push.failureCount = sendResult.failureCount;
                        outcome.push.delivered = sendResult.successCount > 0;

                        // Prune tokens FCM said are permanently dead so the next
                        // send is not slowed by known-bad tokens.
                        if (sendResult.invalidTokens.length > 0)
                        {
                            await PushTokenQueryEngine.removeTokens(sendResult.invalidTokens);
                        }
                    }
                    catch (sendError)
                    {
                        outcome.push.reason = "SEND_FAILED";
                        console.warn(`[NotificationDispatcher] FCM send failed for ${normalisedUserId}: ${sendError.message}`);
                    }
                }
            }
        }

        return outcome;
    }
}

module.exports = NotificationDispatcher;
