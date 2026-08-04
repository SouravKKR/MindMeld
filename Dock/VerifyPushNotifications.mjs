/**
 * End-to-end verification harness for the push-notification + in-app
 * notification feature (FCM via firebase-admin, bitwise channel flags).
 *
 * Run from the Dock directory:
 *     node VerifyPushNotifications.mjs
 *
 * Three tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks: the NotificationDispatcher bitwise
 *      channel routing (IN_APP / PUSH / both / neither), FCM multicast mapping,
 *      configuration gating, invalid-token pruning, and the model round-trips.
 *      Uses monkeypatched static seams (no DB, no network).
 *
 *   2. DB (opt-in: VERIFY_PUSH_DB=1) — drives the real PushTokenQueryEngine and
 *      NotificationQueryEngine against the configured MongoDB (register/list/
 *      remove token; dispatch IN_APP → list → mark read). Creates throwaway
 *      *.invalid rows and cleans them up. Skips if the flag is off / Mongo down.
 *
 *   3. LIVE FCM (opt-in: VERIFY_PUSH_FCM_LIVE=1 + VERIFY_PUSH_TOKEN=<device fcm
 *      token>) — actually sends a push through the real FCM client. Use once the
 *      FIREBASE_* keys are filled. Skips by default.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const NotificationDispatcher = require("./Globals/Classes/Notifications/NotificationDispatcher");
const NotificationBroadcaster = require("./Globals/Classes/Notifications/NotificationBroadcaster");
const NotificationContent = require("./Globals/Classes/Notifications/NotificationContent");
const FirebaseMessagingClient = require("./Globals/Classes/Notifications/FirebaseMessagingClient");
const NotificationQueryEngine = require("./Globals/Classes/Database/NotificationQueryEngine");
const PushTokenQueryEngine = require("./Globals/Classes/Database/PushTokenQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const PushToken = require("./Globals/Model/PushToken");
const NotificationRecord = require("./Globals/Model/NotificationRecord");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const EmailProviderFactory = require("./Globals/Classes/Email/EmailProviderFactory");
const EmailSender = require("./Globals/Classes/Email/EmailSender");
const { notificationChannels } = require("./Globals/Enumerations/NotificationChannels");
const { notificationTypes } = require("./Globals/Enumerations/NotificationTypes");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

function restoreEnv(name, savedValue)
{
    if (savedValue === undefined)
    {
        delete process.env[name];
    }
    else
    {
        process.env[name] = savedValue;
    }
}

async function runAlwaysOnTier()
{
    section("Tier 1 — dispatcher, FCM mapping, models (always on)");

    // Bitwise channel constants compose correctly.
    assert(NotificationDispatcher.IN_APP_ONLY === notificationChannels.IN_APP, "IN_APP_ONLY equals the IN_APP flag");
    assert(NotificationDispatcher.PUSH_ONLY === notificationChannels.PUSH, "PUSH_ONLY equals the PUSH flag");
    assert(NotificationDispatcher.IN_APP_AND_PUSH === (notificationChannels.IN_APP | notificationChannels.PUSH), "IN_APP_AND_PUSH is the bitwise OR of both flags");

    // FCM multicast mapping (verified against firebase-admin sendEachForMulticast input).
    const message = FirebaseMessagingClient.buildMulticastMessage(["tok1", "tok2"], "Title", "Body", { deckId: 7, ok: true });
    assert(Array.isArray(message.tokens) && message.tokens.length === 2, "Multicast message carries the token array");
    assert(message.notification.title === "Title" && message.notification.body === "Body", "Multicast notification maps title + body");
    assert(message.data.deckId === "7" && message.data.ok === "true", "Multicast data values are coerced to strings (FCM requirement)");

    // FCM configuration gating.
    const savedProjectId = process.env.FIREBASE_PROJECT_ID;
    const savedClientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const savedPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    assert(FirebaseMessagingClient.isConfigured() === false, "FCM isConfigured() is false with no service-account creds");
    process.env.FIREBASE_PROJECT_ID = "demo-project";
    process.env.FIREBASE_CLIENT_EMAIL = "svc@demo-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n";
    assert(FirebaseMessagingClient.isConfigured() === true, "FCM isConfigured() is true with all three creds set");
    restoreEnv("FIREBASE_PROJECT_ID", savedProjectId);
    restoreEnv("FIREBASE_CLIENT_EMAIL", savedClientEmail);
    restoreEnv("FIREBASE_PRIVATE_KEY", savedPrivateKey);

    // ── Dispatcher channel routing — monkeypatch the static seams the
    //    dispatcher depends on, so routing is verified with no DB / network.
    const originalInsert = NotificationQueryEngine.insertNotification;
    const originalListTokens = PushTokenQueryEngine.listTokensForUser;
    const originalRemoveTokens = PushTokenQueryEngine.removeTokens;
    const originalIsConfigured = FirebaseMessagingClient.isConfigured;
    const originalSend = FirebaseMessagingClient.sendToTokens;

    let insertCalls = 0;
    let sendCalls = 0;
    let removedTokensArgument = null;

    NotificationQueryEngine.insertNotification = async (record) =>
    {
        insertCalls = insertCalls + 1;
        return { saved: true, notification: record };
    };
    PushTokenQueryEngine.listTokensForUser = async () => ["device-token-a", "device-token-b"];
    PushTokenQueryEngine.removeTokens = async (tokens) => { removedTokensArgument = tokens; return tokens.length; };
    FirebaseMessagingClient.isConfigured = () => true;
    FirebaseMessagingClient.sendToTokens = async () => ({ successCount: 2, failureCount: 0, invalidTokens: [] });

    try
    {
        // IN_APP only → persists, does not attempt push.
        insertCalls = 0; sendCalls = 0;
        const inAppResult = await NotificationDispatcher.dispatch("user-1", { type: notificationTypes.SYSTEM, title: "Hi", body: "There" }, notificationChannels.IN_APP);
        assert(insertCalls === 1, "IN_APP-only dispatch persists exactly one in-app notification");
        assert(inAppResult.inApp.delivered === true && typeof inAppResult.inApp.notificationId === "string", "IN_APP-only dispatch returns a delivered in-app record id");
        assert(inAppResult.push.attempted === false, "IN_APP-only dispatch does NOT attempt push");

        // PUSH only → sends, does not persist in-app.
        insertCalls = 0;
        FirebaseMessagingClient.sendToTokens = async () => { sendCalls = sendCalls + 1; return { successCount: 2, failureCount: 0, invalidTokens: [] }; };
        const pushResult = await NotificationDispatcher.dispatch("user-1", { title: "Hi", body: "There" }, notificationChannels.PUSH);
        assert(insertCalls === 0, "PUSH-only dispatch does NOT persist an in-app notification");
        assert(sendCalls === 1 && pushResult.push.delivered === true && pushResult.push.successCount === 2, "PUSH-only dispatch sends via FCM and reports successCount");

        // IN_APP | PUSH → both.
        insertCalls = 0; sendCalls = 0;
        const bothResult = await NotificationDispatcher.dispatch("user-1", { title: "Hi", body: "There" }, NotificationDispatcher.IN_APP_AND_PUSH);
        assert(insertCalls === 1 && sendCalls === 1, "IN_APP|PUSH dispatch does BOTH persist and send");
        assert(bothResult.inApp.delivered === true && bothResult.push.delivered === true, "IN_APP|PUSH dispatch reports both channels delivered");

        // Invalid-token pruning.
        removedTokensArgument = null;
        FirebaseMessagingClient.sendToTokens = async () => ({ successCount: 1, failureCount: 1, invalidTokens: ["device-token-b"] });
        await NotificationDispatcher.dispatch("user-1", { title: "Hi", body: "There" }, notificationChannels.PUSH);
        assert(Array.isArray(removedTokensArgument) && removedTokensArgument[0] === "device-token-b", "Dispatch prunes tokens FCM reported invalid");

        // PUSH requested but FCM not configured → graceful skip, no throw.
        FirebaseMessagingClient.isConfigured = () => false;
        const unconfiguredResult = await NotificationDispatcher.dispatch("user-1", { title: "Hi", body: "There" }, notificationChannels.PUSH);
        assert(unconfiguredResult.push.attempted === true && unconfiguredResult.push.delivered === false && unconfiguredResult.push.reason === "FCM_NOT_CONFIGURED", "PUSH before FCM is configured degrades to FCM_NOT_CONFIGURED (no throw)");

        // PUSH configured but user has no tokens → NO_TOKENS.
        FirebaseMessagingClient.isConfigured = () => true;
        PushTokenQueryEngine.listTokensForUser = async () => [];
        const noTokensResult = await NotificationDispatcher.dispatch("user-1", { title: "Hi", body: "There" }, notificationChannels.PUSH);
        assert(noTokensResult.push.reason === "NO_TOKENS" && noTokensResult.push.delivered === false, "PUSH with no registered tokens reports NO_TOKENS");
    }
    finally
    {
        NotificationQueryEngine.insertNotification = originalInsert;
        PushTokenQueryEngine.listTokensForUser = originalListTokens;
        PushTokenQueryEngine.removeTokens = originalRemoveTokens;
        FirebaseMessagingClient.isConfigured = originalIsConfigured;
        FirebaseMessagingClient.sendToTokens = originalSend;
    }
}

/**
 * The EMAIL channel. Email is currently the ONLY channel that reaches a user who
 * has closed the app — device push has no client-side token registration yet —
 * so its routing and, above all, its failure modes matter: a notification must
 * never be able to fail the pipeline that raised it.
 */
async function runEmailChannelChecks()
{
    section("Tier 1e — EMAIL channel routing + degradation (always on)");

    assert(notificationChannels.EMAIL === 4, "notificationChannels.EMAIL is the third bit (4)");
    assert(NotificationDispatcher.EMAIL_ONLY === notificationChannels.EMAIL, "EMAIL_ONLY equals the EMAIL flag");
    assert(
        NotificationDispatcher.IN_APP_AND_PUSH_AND_EMAIL === (notificationChannels.IN_APP | notificationChannels.PUSH | notificationChannels.EMAIL),
        "IN_APP_AND_PUSH_AND_EMAIL is the bitwise OR of all three flags");

    const originalInsert = NotificationQueryEngine.insertNotification;
    const originalListTokens = PushTokenQueryEngine.listTokensForUser;
    const originalIsConfigured = FirebaseMessagingClient.isConfigured;
    const originalGetUserById = AuthenticationQueryEngine.getUserById;
    const originalGetDefaultProvider = EmailProviderFactory.getDefaultProvider;
    const originalSendNotificationEmail = EmailSender.sendNotificationEmail;

    let sentToAddress = null;
    let sentContent = null;

    NotificationQueryEngine.insertNotification = async () => ({ saved: true });
    PushTokenQueryEngine.listTokensForUser = async () => [];
    FirebaseMessagingClient.isConfigured = () => false;
    AuthenticationQueryEngine.getUserById = async () => ({ getAdditionalData: () => ({ email: "learner@example.invalid" }) });
    EmailProviderFactory.getDefaultProvider = () => ({ isConfigured: () => true });
    EmailSender.sendNotificationEmail = async (toEmailAddress, emailContent) =>
    {
        sentToAddress = toEmailAddress;
        sentContent = emailContent;
    };

    try
    {
        // EMAIL requested → resolves the address from the user record and sends.
        sentToAddress = null;
        const emailResult = await NotificationDispatcher.dispatch("user-1", NotificationContent.generationComplete("42"), notificationChannels.EMAIL);
        assert(emailResult.email.attempted === true && emailResult.email.delivered === true, "EMAIL-only dispatch reports a delivered email");
        assert(sentToAddress === "learner@example.invalid", "EMAIL dispatch resolves the recipient from the user's additionalData.email");
        assert(sentContent.subject === "Your CogniumLearn study set is ready", "generationComplete supplies its own email subject");
        assert(sentContent.callToActionLabel === NotificationContent.DEFAULT_EMAIL_CALL_TO_ACTION_LABEL, "generationComplete carries a call-to-action label");

        // EMAIL not requested → not attempted at all.
        sentToAddress = null;
        const withoutEmailResult = await NotificationDispatcher.dispatch("user-1", NotificationContent.generationComplete("42"), notificationChannels.IN_APP);
        assert(withoutEmailResult.email.attempted === false && sentToAddress === null, "A dispatch without the EMAIL flag never touches the email path");

        // A user with no stored address → reported, not thrown.
        AuthenticationQueryEngine.getUserById = async () => ({ getAdditionalData: () => ({}) });
        const noAddressResult = await NotificationDispatcher.dispatch("user-1", NotificationContent.generationComplete("42"), notificationChannels.EMAIL);
        assert(noAddressResult.email.reason === "NO_EMAIL_ADDRESS" && noAddressResult.email.delivered === false, "EMAIL for a user with no address reports NO_EMAIL_ADDRESS (no throw)");

        // No mail credentials → degrades exactly like FCM_NOT_CONFIGURED does.
        AuthenticationQueryEngine.getUserById = async () => ({ getAdditionalData: () => ({ email: "learner@example.invalid" }) });
        EmailProviderFactory.getDefaultProvider = () => ({ isConfigured: () => false });
        const unconfiguredResult = await NotificationDispatcher.dispatch("user-1", NotificationContent.generationComplete("42"), notificationChannels.EMAIL);
        assert(unconfiguredResult.email.reason === "EMAIL_NOT_CONFIGURED" && unconfiguredResult.email.delivered === false, "EMAIL before mail credentials exist degrades to EMAIL_NOT_CONFIGURED (no throw)");

        // The provider throwing must not escape into the caller's pipeline.
        EmailProviderFactory.getDefaultProvider = () => ({ isConfigured: () => true });
        EmailSender.sendNotificationEmail = async () => { throw new Error("mail server unreachable"); };
        const failedResult = await NotificationDispatcher.dispatch("user-1", NotificationContent.generationComplete("42"), notificationChannels.EMAIL);
        assert(failedResult.email.reason === "SEND_FAILED" && failedResult.email.delivered === false, "A throwing mail provider reports SEND_FAILED instead of propagating");

        // A notification with no email block still produces a sendable message.
        EmailSender.sendNotificationEmail = async (toEmailAddress, emailContent) => { sentContent = emailContent; };
        await NotificationDispatcher.dispatch("user-1", { title: "Bare title", body: "Bare body" }, notificationChannels.EMAIL);
        assert(sentContent.subject === "Bare title" && sentContent.introText === "Bare body", "A notification without an email block falls back to its in-app title + body");
        assert(sentContent.footerText === NotificationContent.DEFAULT_EMAIL_FOOTER_TEXT, "The fallback email still carries the default footer");

        // Every generation-completion builder must be email-ready.
        for (const [builderName, notification] of [["generationComplete", NotificationContent.generationComplete("1")], ["deckAnalysisComplete", NotificationContent.deckAnalysisComplete("1")]])
        {
            const emailContent = NotificationContent.toEmailContent(notification);
            assert(
                emailContent.subject.length > 0 && emailContent.headingText.length > 0 && emailContent.introText.length > 0,
                `${builderName} resolves to a complete email payload`);
        }
    }
    finally
    {
        NotificationQueryEngine.insertNotification = originalInsert;
        PushTokenQueryEngine.listTokensForUser = originalListTokens;
        FirebaseMessagingClient.isConfigured = originalIsConfigured;
        AuthenticationQueryEngine.getUserById = originalGetUserById;
        EmailProviderFactory.getDefaultProvider = originalGetDefaultProvider;
        EmailSender.sendNotificationEmail = originalSendNotificationEmail;
    }

    // Model round-trips.
    const pushToken = new PushToken({ userId: "u1", token: "tok", platform: 5, createdAt: new Date("2026-01-01T00:00:00Z"), lastSeenAt: new Date("2026-01-02T00:00:00Z") });
    const pushTokenJson = pushToken.toJson();
    assert(pushTokenJson.userId === "u1" && pushTokenJson.token === "tok" && pushTokenJson.platform === 5, "PushToken.toJson carries its fields");
    assert(typeof pushToken.getId() === "string" && pushToken.getId().length > 0, "PushToken auto-generates an id when none is given");
    const rebuiltPushToken = PushToken.fromJson(pushTokenJson);
    assert(rebuiltPushToken.getId() === pushToken.getId() && rebuiltPushToken.getCreatedAt().toISOString() === pushTokenJson.createdAt, "PushToken fromJson→toJson round-trips");

    const unread = new NotificationRecord({ userId: "u1", type: notificationTypes.ANNOUNCEMENT, title: "T", body: "B" });
    assert(unread.getReadAt() === null && unread.isRead() === false, "A new NotificationRecord is unread (readAt null)");
    unread.setReadAt(new Date());
    assert(unread.isRead() === true, "Setting readAt marks the notification read");
    const clamped = new NotificationRecord({ title: "x".repeat(300) });
    assert(clamped.getTitle().length === 256, "NotificationRecord clamps an over-long title to 256 chars");
}

function runContentBuilderChecks()
{
    section("Tier 1b — NotificationContent builders (always on)");

    // Every builder must return a usable, well-typed notification. Args are
    // representative; the point is shape + a real type + non-empty copy.
    const builders =
    [
        ["generationComplete", NotificationContent.generationComplete("42"), notificationTypes.GENERATION_COMPLETE],
        ["deckAnalysisComplete", NotificationContent.deckAnalysisComplete("42"), notificationTypes.GENERATION_COMPLETE],
        ["deckPurchaseComplete", NotificationContent.deckPurchaseComplete(2), notificationTypes.PURCHASE],
        ["creditTopUpComplete", NotificationContent.creditTopUpComplete(100, 250), notificationTypes.CREDITS],
        ["creditsGrantedByAdmin", NotificationContent.creditsGrantedByAdmin(50), notificationTypes.CREDITS],
        ["recurringCreditsGranted", NotificationContent.recurringCreditsGranted(30), notificationTypes.CREDITS],
        ["signupCreditsGranted", NotificationContent.signupCreditsGranted(20), notificationTypes.CREDITS],
        ["outOfCredits", NotificationContent.outOfCredits("generation"), notificationTypes.CREDITS],
        ["newDeviceSignIn", NotificationContent.newDeviceSignIn("Chrome on Windows"), notificationTypes.SECURITY],
        ["subscriptionActivated", NotificationContent.subscriptionActivated(), notificationTypes.SUBSCRIPTION],
        ["subscriptionRenewed", NotificationContent.subscriptionRenewed(), notificationTypes.SUBSCRIPTION],
        ["subscriptionPaymentPending", NotificationContent.subscriptionPaymentPending(), notificationTypes.SUBSCRIPTION],
        ["subscriptionHalted", NotificationContent.subscriptionHalted(), notificationTypes.SUBSCRIPTION],
        ["subscriptionCancelled", NotificationContent.subscriptionCancelled(), notificationTypes.SUBSCRIPTION],
        ["subscriptionCompleted", NotificationContent.subscriptionCompleted(), notificationTypes.SUBSCRIPTION],
        ["addedToOrganization", NotificationContent.addedToOrganization("Acme Institute"), notificationTypes.ORGANIZATION]
    ];

    for (const [name, content, expectedType] of builders)
    {
        const isValid = content
            && content.type === expectedType
            && typeof content.title === "string" && content.title.length > 0
            && typeof content.body === "string" && content.body.length > 0
            && content.data !== null && typeof content.data === "object";
        assert(isValid, `NotificationContent.${name}() returns a well-formed ${Object.keys(notificationTypes).find(key => notificationTypes[key] === expectedType)} notification`);
    }

    // Purchase copy pluralises.
    assert(NotificationContent.deckPurchaseComplete(1).body.includes("deck is"), "deckPurchaseComplete(1) uses singular copy");
    assert(NotificationContent.deckPurchaseComplete(3).body.includes("decks are"), "deckPurchaseComplete(3) uses plural copy");
}

// A minimal async-iterable users cursor, mimicking the Mongo cursor the
// broadcaster iterates (find().batchSize() → for await).
function makeFakeUsersDatabase(userIds)
{
    return {
        collection: () => ({
            find: () => ({
                batchSize: () => ({
                    async *[Symbol.asyncIterator]()
                    {
                        for (const userId of userIds)
                        {
                            yield { id: userId };
                        }
                    }
                })
            })
        })
    };
}

async function runBroadcasterChecks()
{
    section("Tier 1c — NotificationBroadcaster fan-out (always on)");

    const originalGetDatabase = DatabaseConnector.getDatabase;
    const originalInsertMany = NotificationQueryEngine.insertManyForUsers;
    const originalStreamAll = PushTokenQueryEngine.streamAllTokens;
    const originalRemoveTokens = PushTokenQueryEngine.removeTokens;
    const originalIsConfigured = FirebaseMessagingClient.isConfigured;
    const originalSend = FirebaseMessagingClient.sendToTokens;

    let insertedUserIds = null;
    let removedTokensArgument = null;

    DatabaseConnector.getDatabase = async () => makeFakeUsersDatabase(["u1", "u2", "u3"]);
    NotificationQueryEngine.insertManyForUsers = async (userIds) => { insertedUserIds = userIds; return userIds.length; };
    PushTokenQueryEngine.streamAllTokens = async (batchSize, handler) => { await handler(["ta", "tb"]); return 2; };
    PushTokenQueryEngine.removeTokens = async (tokens) => { removedTokensArgument = tokens; return tokens.length; };
    FirebaseMessagingClient.isConfigured = () => true;
    FirebaseMessagingClient.sendToTokens = async () => ({ successCount: 2, failureCount: 0, invalidTokens: ["tb"] });

    try
    {
        // IN_APP broadcast persists one per user (streamed).
        const inAppOutcome = await NotificationBroadcaster.broadcastToAllUsers(NotificationContent.subscriptionActivated(), notificationChannels.IN_APP);
        assert(inAppOutcome.inApp.recipientCount === 3 && inAppOutcome.inApp.delivered === true, "IN_APP broadcast persists one notification per user");
        assert(Array.isArray(insertedUserIds) && insertedUserIds.length === 3, "IN_APP broadcast streamed all user ids to insertManyForUsers");

        // PUSH broadcast streams tokens, sends, and prunes invalid ones.
        const pushOutcome = await NotificationBroadcaster.broadcastToAllUsers(NotificationContent.subscriptionRenewed(), notificationChannels.PUSH);
        assert(pushOutcome.push.tokenCount === 2 && pushOutcome.push.successCount === 2 && pushOutcome.push.delivered === true, "PUSH broadcast sends to every streamed token");
        assert(Array.isArray(removedTokensArgument) && removedTokensArgument[0] === "tb", "PUSH broadcast prunes tokens FCM reported invalid");

        // PUSH broadcast before FCM is configured degrades, no throw.
        FirebaseMessagingClient.isConfigured = () => false;
        const unconfigured = await NotificationBroadcaster.broadcastToAllUsers(NotificationContent.subscriptionRenewed(), notificationChannels.PUSH);
        assert(unconfigured.push.attempted === true && unconfigured.push.delivered === false && unconfigured.push.reason === "FCM_NOT_CONFIGURED", "PUSH broadcast before FCM configured degrades to FCM_NOT_CONFIGURED");
    }
    finally
    {
        DatabaseConnector.getDatabase = originalGetDatabase;
        NotificationQueryEngine.insertManyForUsers = originalInsertMany;
        PushTokenQueryEngine.streamAllTokens = originalStreamAll;
        PushTokenQueryEngine.removeTokens = originalRemoveTokens;
        FirebaseMessagingClient.isConfigured = originalIsConfigured;
        FirebaseMessagingClient.sendToTokens = originalSend;
    }
}

function runWiredModuleSmoke()
{
    section("Tier 1d — wired trigger modules load (always on)");

    const wiredModules =
    [
        "./Endpoints/AutomaticGeneration/Generate",
        "./Globals/Classes/Task/OrphanedGenerationReconciler",
        "./Endpoints/Analysis/QueueDeckAnalysis",
        "./Endpoints/PaidDeck/VerifyPurchase",
        "./Globals/Classes/Credits/CreditPurchaseCompletionService",
        "./Globals/Classes/Credits/CreditGrantExecutor",
        "./Globals/Classes/Credits/PeriodicCreditReconciler",
        "./Globals/Classes/Authentication/OtpManager",
        "./Endpoints/Authentication/HandleLoginCallback",
        "./Globals/Classes/Database/AuthenticationQueryEngine",
        "./Globals/Classes/Plans/SubscriptionWebhookProcessor",
        "./Endpoints/OrganizationAdmin/AddOrganizationMember"
    ];

    let loadFailure = null;
    for (const wiredModule of wiredModules)
    {
        try
        {
            require(wiredModule);
        }
        catch (loadError)
        {
            loadFailure = `${wiredModule}: ${loadError.message}`;
            break;
        }
    }

    assert(loadFailure === null, loadFailure === null ? `All ${wiredModules.length} wired trigger modules load (no syntax / circular-require breakage)` : `Wired module failed to load — ${loadFailure}`);
}

async function runDatabaseTier()
{
    section("Tier 2 — real query engines + dispatch persistence (opt-in: VERIFY_PUSH_DB=1)");

    if (process.env.VERIFY_PUSH_DB !== "1")
    {
        skip("DB tier disabled (set VERIFY_PUSH_DB=1 to exercise Mongo)");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("MongoDB is not reachable — DB tier skipped");
        return;
    }

    console.log(`  info  Using database "${process.env.MONGODB_DATABASE_NAME}" — creating throwaway *.invalid rows`);

    const testUserId = `verify-push-${Date.now()}@cogniumlearn.invalid`;
    const testToken = `token-${Date.now()}`;

    try
    {
        // Push token register / list / idempotency / remove.
        const firstRegister = await PushTokenQueryEngine.registerToken(testUserId, testToken, 1);
        assert(firstRegister.registered === true, "registerToken returns registered=true on first insert");
        const secondRegister = await PushTokenQueryEngine.registerToken(testUserId, testToken, 1);
        assert(secondRegister.registered === false, "registerToken is idempotent (registered=false on repeat)");
        const tokens = await PushTokenQueryEngine.listTokensForUser(testUserId);
        assert(tokens.length === 1 && tokens[0] === testToken, "listTokensForUser returns the registered token");
        const removeResult = await PushTokenQueryEngine.removeToken(testUserId, testToken);
        assert(removeResult.removed === true, "removeToken deletes the token");
        assert((await PushTokenQueryEngine.listTokensForUser(testUserId)).length === 0, "token list is empty after removal");

        // In-app notification via dispatch → list → mark read.
        const dispatchResult = await NotificationDispatcher.dispatch(testUserId, { type: notificationTypes.SYSTEM, title: "E2E", body: "hello" }, notificationChannels.IN_APP);
        assert(dispatchResult.inApp.delivered === true, "IN_APP dispatch persisted a notification");
        const notificationId = dispatchResult.inApp.notificationId;

        const listed = await NotificationQueryEngine.listForUser(testUserId, 50);
        assert(listed.length === 1 && listed[0].id === notificationId && listed[0].readAt === null, "listForUser returns the unread notification");

        const markResult = await NotificationQueryEngine.markRead(testUserId, notificationId);
        assert(markResult.updated === true, "markRead updates the notification");
        const relisted = await NotificationQueryEngine.listForUser(testUserId, 50);
        assert(relisted[0].readAt !== null, "notification is read after markRead");

        const markMissing = await NotificationQueryEngine.markRead(testUserId, "does-not-exist");
        assert(markMissing.updated === false, "markRead reports not-updated for an unknown id");
    }
    finally
    {
        try { await database.collection(DatabaseConstants.PUSH_TOKENS_COLLECTION).deleteMany({ userId: testUserId }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.NOTIFICATIONS_COLLECTION).deleteMany({ userId: testUserId }); } catch (cleanupError) { }
        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
    }
}

async function runLiveFcmTier()
{
    section("Tier 3 — live FCM send (opt-in: VERIFY_PUSH_FCM_LIVE=1)");

    if (process.env.VERIFY_PUSH_FCM_LIVE !== "1")
    {
        skip("Live FCM tier disabled (set VERIFY_PUSH_FCM_LIVE=1 + VERIFY_PUSH_TOKEN=<device token> to send a real push)");
        return;
    }

    const deviceToken = process.env.VERIFY_PUSH_TOKEN || "";
    if (!deviceToken)
    {
        skip("VERIFY_PUSH_TOKEN is not set — cannot send a live push");
        return;
    }

    if (!FirebaseMessagingClient.isConfigured())
    {
        skip("FIREBASE_* creds are incomplete — live send skipped");
        return;
    }

    try
    {
        const result = await FirebaseMessagingClient.sendToTokens([deviceToken], "CogniumLearn test push", "If you can see this, FCM works.", { source: "verify-harness" });
        assert(result.successCount === 1, `Live FCM send succeeded (successCount=${result.successCount}, failureCount=${result.failureCount})`);
    }
    catch (liveSendError)
    {
        assert(false, `Live FCM send failed: ${liveSendError.message}`);
    }
}

async function main()
{
    console.log("CogniumLearn — Push notification (FCM) + bitwise dispatcher verification\n");

    await runAlwaysOnTier();
    runContentBuilderChecks();
    await runBroadcasterChecks();
    runWiredModuleSmoke();
    await runEmailChannelChecks();
    await runDatabaseTier();
    await runLiveFcmTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
