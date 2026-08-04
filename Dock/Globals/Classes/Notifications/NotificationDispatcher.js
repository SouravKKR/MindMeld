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
 *   - EMAIL   → send a branded notification email to the address on the user's
 *               account. Today this is the ONLY channel that reliably reaches
 *               someone who has closed the app — see the PUSH branch below.
 *
 * Bits compose freely; a requested channel that is unavailable (e.g. PUSH
 * before the FCM keys are configured, or EMAIL for a user with no address) is
 * skipped gracefully — the dispatch never throws for a delivery problem, it
 * reports per-channel outcomes in the returned object.
 */
class NotificationDispatcher
{
    // Convenient defaults for common call sites.
    static IN_APP_ONLY = notificationChannels.IN_APP;
    static PUSH_ONLY = notificationChannels.PUSH;
    static EMAIL_ONLY = notificationChannels.EMAIL;
    static IN_APP_AND_PUSH = notificationChannels.IN_APP | notificationChannels.PUSH;
    static IN_APP_AND_PUSH_AND_EMAIL = notificationChannels.IN_APP | notificationChannels.PUSH | notificationChannels.EMAIL;

    static #hasChannel(channelFlags, channel)
    {
        return (channelFlags & channel) === channel;
    }

    /**
     * @param {string} userId
     * @param {{type?:number, title?:string, body?:string, data?:object}} notification
     * @param {number} channelFlags  bitwise OR of notificationChannels members
     * @returns {Promise<{inApp:{delivered:boolean, notificationId:(string|null)}, push:{delivered:boolean, attempted:boolean, successCount:number, failureCount:number, reason:(string|null)}, email:{delivered:boolean, attempted:boolean, reason:(string|null)}}>}
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
            push: { delivered: false, attempted: false, successCount: 0, failureCount: 0, reason: null },
            email: { delivered: false, attempted: false, reason: null }
        };

        if (!normalisedUserId)
        {
            outcome.push.reason = "NO_USER";
            outcome.email.reason = "NO_USER";
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
        //
        // ⚠ REAL DEVICE NOTIFICATIONS DO NOT REACH ANYONE YET. ⚠
        //
        // Everything server-side is finished and correct here — FCM multicast,
        // batching, dead-token pruning, graceful degradation. What is missing is
        // the client half: nothing in Main/ calls POST
        // /Notifications/RegisterPushToken, there is no Firebase messaging SDK
        // on the frontend, and there is no push service worker. So
        // PushTokenQueryEngine.listTokensForUser() returns an empty array for
        // every real user and this branch always reports NO_TOKENS.
        //
        // Until that lands, the only completion signals that actually leave the
        // browser are the EMAIL channel below and GenerationNotifier's
        // page-local Notifications API popup, which needs a live tab.
        //
        // ► THIS IS WHERE REAL DEVICE NOTIFICATIONS GET WIRED IN. To finish it:
        //   add the Firebase messaging SDK and a push service worker to Main/,
        //   request permission, POST the FCM registration token to
        //   /Notifications/RegisterPushToken, and unregister it on logout.
        //   Nothing in THIS file has to change when that ships — the tokens
        //   simply start arriving and this branch starts delivering.
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

        // ── EMAIL channel ────────────────────────────────────────────────────
        if (NotificationDispatcher.#hasChannel(flags, notificationChannels.EMAIL))
        {
            outcome.email.attempted = true;
            await NotificationDispatcher.#deliverEmail(normalisedUserId, notification, outcome);
        }

        return outcome;
    }

    /**
     * Sends the notification as email, recording why on every path that does not
     * deliver. Split out so the dispatch method stays readable now that there
     * are three channels.
     *
     * Every dependency is required lazily. AuthenticationQueryEngine already
     * requires THIS class the same way (for its new-device sign-in alert), so a
     * top-level require here would close that cycle; the email modules are kept
     * lazy alongside it so nothing on Dock's boot path pulls in the SES client.
     *
     * Never throws — a notification is best-effort, and the pipeline that raised
     * it must not fail because a mail server did.
     */
    static async #deliverEmail(userId, notification, outcome)
    {
        try
        {
            const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
            const EmailProviderFactory = require("../Email/EmailProviderFactory");
            const EmailSender = require("../Email/EmailSender");
            const NotificationContent = require("./NotificationContent");

            const recipient = await AuthenticationQueryEngine.getUserById(userId);
            const emailAddress = String(recipient?.getAdditionalData()?.email ?? "").trim();

            if (emailAddress.length === 0)
            {
                // A Google-flow account with no stored address, or a deleted
                // user. Nothing to do, and nothing wrong.
                outcome.email.reason = "NO_EMAIL_ADDRESS";
                return;
            }

            if (!EmailProviderFactory.getDefaultProvider().isConfigured())
            {
                // Same shape as the FCM guard above: an environment without mail
                // credentials degrades quietly instead of throwing.
                outcome.email.reason = "EMAIL_NOT_CONFIGURED";
                return;
            }

            await EmailSender.sendNotificationEmail(emailAddress, NotificationContent.toEmailContent(notification));
            outcome.email.delivered = true;
        }
        catch (emailError)
        {
            outcome.email.reason = "SEND_FAILED";
            console.warn(`[NotificationDispatcher] Email send failed for ${userId}: ${emailError.message}`);
        }
    }
}

module.exports = NotificationDispatcher;
