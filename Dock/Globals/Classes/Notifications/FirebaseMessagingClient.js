const App = require("../App");

// firebase-admin is required lazily (inside the methods that need it), not at
// module load. It is a heavy dependency, and many notification call sites live
// on boot-loaded modules — deferring the require keeps server boot fast and
// means firebase-admin is only ever loaded when a PUSH is actually dispatched
// against a configured project. isConfigured() / buildMulticastMessage() work
// without it.

/**
 * Thin wrapper over the Firebase Admin SDK's Cloud Messaging service — the only
 * layer that talks to FCM. It sends a notification to a set of device
 * registration tokens and reports back which tokens FCM rejected as permanently
 * invalid so the caller (NotificationDispatcher) can prune them.
 *
 * FCM is the unified transport across web, Android and iOS: the send path here
 * is identical regardless of the device platform — only how each client
 * obtains its token differs. Verified against the firebase-admin Node.js API
 * (initializeApp + cert, getMessaging().sendEachForMulticast).
 *
 * The Firebase app is created lazily and only once (guarded by getApps()), and
 * only when credentials are present — so a deployment without FCM keys boots
 * and runs normally, with isConfigured() false and sends short-circuiting.
 */
class FirebaseMessagingClient
{
    static #FIREBASE_APP_NAME = "cogniumlearn-messaging";

    // FCM error codes that mean the token is dead and must be removed. A token
    // can become unregistered when the app is uninstalled, the token rotates,
    // or (iOS) APNs reports it invalid. Verified against the firebase-admin
    // messaging error-code set.
    static #PRUNABLE_ERROR_CODES = new Set
    ([
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token",
        "messaging/invalid-argument"
    ]);

    // Per FCM, sendEachForMulticast accepts at most 500 tokens per call.
    static MAX_TOKENS_PER_MULTICAST = 500;

    static #firebaseApp = null;

    static isConfigured()
    {
        return App.getFirebaseProjectId().length > 0
            && App.getFirebaseClientEmail().length > 0
            && App.getFirebasePrivateKey().length > 0;
    }

    static #getFirebaseApp()
    {
        if (FirebaseMessagingClient.#firebaseApp !== null)
        {
            return FirebaseMessagingClient.#firebaseApp;
        }

        if (!FirebaseMessagingClient.isConfigured())
        {
            throw new Error("Firebase Cloud Messaging is not configured — set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in Dock/.env");
        }

        const { initializeApp, cert, getApps } = require("firebase-admin/app");

        // Reuse an already-initialised named app across hot reloads / repeated
        // requires; only create it once.
        const existingApp = getApps().find(application => application.name === FirebaseMessagingClient.#FIREBASE_APP_NAME);
        if (existingApp)
        {
            FirebaseMessagingClient.#firebaseApp = existingApp;
            return FirebaseMessagingClient.#firebaseApp;
        }

        FirebaseMessagingClient.#firebaseApp = initializeApp
        (
            {
                credential: cert
                ({
                    projectId: App.getFirebaseProjectId(),
                    clientEmail: App.getFirebaseClientEmail(),
                    privateKey: App.getFirebasePrivateKey()
                })
            },
            FirebaseMessagingClient.#FIREBASE_APP_NAME
        );

        return FirebaseMessagingClient.#firebaseApp;
    }

    /**
     * Builds the FCM multicast message from a notification. Split out so the
     * mapping is unit-testable without a live FCM connection. `data` values
     * must be strings (an FCM requirement), so every value is coerced.
     */
    static buildMulticastMessage(tokens, title, body, data)
    {
        const stringData = {};
        if (data !== null && typeof data === "object")
        {
            for (const key of Object.keys(data))
            {
                stringData[key] = String(data[key]);
            }
        }

        return {
            tokens: tokens,
            notification:
            {
                title: String(title ?? ""),
                body: String(body ?? "")
            },
            data: stringData
        };
    }

    /**
     * Sends a notification to the given registration tokens (in batches of 500).
     * Returns { successCount, failureCount, invalidTokens } where invalidTokens
     * are the tokens FCM said to permanently drop. Never throws for per-token
     * failures — only for a hard configuration error.
     */
    static async sendToTokens(tokens, title, body, data)
    {
        const uniqueTokens = Array.from(new Set((tokens || []).filter(token => typeof token === "string" && token.length > 0)));
        if (uniqueTokens.length === 0)
        {
            return { successCount: 0, failureCount: 0, invalidTokens: [] };
        }

        const { getMessaging } = require("firebase-admin/messaging");
        const messaging = getMessaging(FirebaseMessagingClient.#getFirebaseApp());

        let successCount = 0;
        let failureCount = 0;
        const invalidTokens = [];

        for (let batchStart = 0; batchStart < uniqueTokens.length; batchStart += FirebaseMessagingClient.MAX_TOKENS_PER_MULTICAST)
        {
            const batchTokens = uniqueTokens.slice(batchStart, batchStart + FirebaseMessagingClient.MAX_TOKENS_PER_MULTICAST);
            const message = FirebaseMessagingClient.buildMulticastMessage(batchTokens, title, body, data);

            const batchResponse = await messaging.sendEachForMulticast(message);
            successCount = successCount + batchResponse.successCount;
            failureCount = failureCount + batchResponse.failureCount;

            batchResponse.responses.forEach((singleResponse, responseIndex) =>
            {
                if (!singleResponse.success)
                {
                    const errorCode = singleResponse.error?.code || "";
                    if (FirebaseMessagingClient.#PRUNABLE_ERROR_CODES.has(errorCode))
                    {
                        invalidTokens.push(batchTokens[responseIndex]);
                    }
                }
            });
        }

        return { successCount: successCount, failureCount: failureCount, invalidTokens: invalidTokens };
    }
}

module.exports = FirebaseMessagingClient;
