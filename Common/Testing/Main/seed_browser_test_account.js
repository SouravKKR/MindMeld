// Seeds (or refreshes) the throwaway account the Puppeteer browser suites drive:
// run_tutorial_ui_tests.js and run_critical_flow_tests.js. Both need a session
// that reaches the AUTHENTICATED home page — without one they SKIP and prove
// nothing, which fails the deploy gate.
//
//   node Common/Testing/Main/seed_browser_test_account.js
//
// Prints the sessionId to put in deployment.env as TUTORIAL_TEST_SESSION_COOKIE.
//
// Env: MONGODB_URL / MONGODB_DATABASE_NAME override Dock/.env (useful when Mongo
//      is reachable on a different host/port than the server's own config says),
//      TEST_ACCOUNT_ID / TEST_SESSION_ID override the defaults below.
//
// The account is deliberately EMPTY and separate from any real user: both suites
// create and delete real decks, cards and study materials as they run. Never
// point this at a production database or a real account.

const path = require("path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..", "..");
const DOCK_DIRECTORY = path.join(REPOSITORY_ROOT, "Dock");

require(path.join(DOCK_DIRECTORY, "node_modules", "dotenv")).config({ path: path.join(DOCK_DIRECTORY, ".env") });
const { MongoClient } = require(path.join(DOCK_DIRECTORY, "node_modules", "mongodb"));
// Reused for its consent-field naming only (pure static helpers), so the seeded
// account can never drift from what the server's own acceptance gate reads.
const LegalAcceptanceService = require(path.join(DOCK_DIRECTORY, "Globals", "Classes", "Authentication", "LegalAcceptanceService"));

const MONGODB_URL = process.env.MONGODB_URL;
const MONGODB_DATABASE_NAME = process.env.MONGODB_DATABASE_NAME;
const TEST_ACCOUNT_ID = process.env.TEST_ACCOUNT_ID || "browser-suite-test-user";
const TEST_SESSION_ID = process.env.TEST_SESSION_ID || "browser-suite-test-session";

const THIRTY_DAYS_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_AUTHENTICATION_PROVIDER = 1;

// The suites drive a first-launch-shaped browser profile, so the account must
// already have accepted the current legal documents or the terms modal blocks
// everything.
//
// The `legalDocuments` collection is the authority: LegalAcceptanceService
// compares each document's CURRENT version against the account's stored
// agreed<Document>Version, so anything lower leaves acceptance outstanding.
// Reading a reference *user* instead used to fall back to version 1 on a fresh
// database (no other users yet) while Dock's LegalDocumentSeeder had already
// published version 6 — the terms dialog then rendered over the app and the
// tutorial gate reported it as "the + tile click had no effect", which looks
// nothing like the consent mismatch it actually was.
//
// Every seeded document is stamped, not a hardcoded pair, so a newly added
// legal document needs no change here.
async function buildAcceptedLegalFields(database)
{
    const legalDocuments = await database.collection("legalDocuments").find({}).toArray();
    const acceptedAt = new Date().toISOString();
    const acceptedLegalFields = {};

    for (const legalDocument of legalDocuments)
    {
        acceptedLegalFields[LegalAcceptanceService.buildAgreedVersionKey(legalDocument.key)] = Number(legalDocument.version);
        acceptedLegalFields[LegalAcceptanceService.buildAgreedAtKey(legalDocument.key)] = acceptedAt;
    }

    return acceptedLegalFields;
}

(async () =>
{
    if (!MONGODB_URL || !MONGODB_DATABASE_NAME)
    {
        console.error("MONGODB_URL / MONGODB_DATABASE_NAME are not set (Dock/.env not found?).");
        process.exit(1);
    }

    const client = new MongoClient(MONGODB_URL, { serverSelectionTimeoutMS: 10000 });
    await client.connect();

    const database = client.db(MONGODB_DATABASE_NAME);
    const acceptedLegalFields = await buildAcceptedLegalFields(database);

    await database.collection("users").updateOne(
        { id: TEST_ACCOUNT_ID },
        {
            $set:
            {
                id: TEST_ACCOUNT_ID,
                // `displayName`, not `name`: the field the User model actually
                // reads (Common/Classes/User.json). Seeded under the wrong key
                // the account has no name at all, and every surface that shows
                // one — the profile pill above all — renders a fixture that no
                // real account resembles.
                displayName: "Browser Suite Test",
                additionalData:
                {
                    displayPicture: "",
                    email: `${TEST_ACCOUNT_ID}@localhost.test`,
                    credits: 100,
                    // Same reasoning as the legal fields above, for the age
                    // gate: EnsureAgeConsent 403s every protected endpoint
                    // while an account has no date of birth on file, so an
                    // unseeded fixture would fail every suite with a blocking
                    // modal over the app — the identical failure mode the
                    // legal-acceptance comment describes, which presents as
                    // "the click had no effect" rather than as a gate.
                    //
                    // A fixed adult date, not a computed one: the suites assert
                    // on rendered state, and a date of birth that drifts with
                    // the run date is a fixture that changes under the tests.
                    dateOfBirth: "1990-01-01",
                    dateOfBirthRecordedAt: new Date().toISOString(),
                    ...acceptedLegalFields
                }
            }
        },
        { upsert: true }
    );

    const now = new Date();
    await database.collection("sessions").updateOne(
        { id: TEST_SESSION_ID },
        {
            $set:
            {
                id: TEST_SESSION_ID,
                userId: TEST_ACCOUNT_ID,
                provider: GOOGLE_AUTHENTICATION_PROVIDER,
                deviceId: "browser-suite-test-device",
                creationDate: now,
                lastRefreshDate: now,
                expirationDate: new Date(now.getTime() + THIRTY_DAYS_MILLISECONDS)
            }
        },
        { upsert: true }
    );

    // Seed the Root deck every real account owns. Without it the account has
    // ZERO synced entities, and the first pull comes back with totalCount:0 —
    // which the client reads as "sync completed but no data was returned and
    // your library is empty", i.e. a suspect pull rather than a legitimately
    // empty account. It then sits on the blocking "Restoring sync state" modal,
    // which holds the BlockingOverlayCoordinator slot and stops the tutorials
    // from ever mounting. One Root deck makes the account a normal, non-empty
    // synced account and the first sync completes.
    await database.collection("decks").updateOne(
        { userId: TEST_ACCOUNT_ID, "data.id": "0" },
        {
            $set:
            {
                userId: TEST_ACCOUNT_ID,
                data:
                {
                    id: "0",
                    name: "Root",
                    shortName: "Root",
                    tags: [],
                    lifecycle:
                    {
                        creationDate: new Date(0).toISOString(),
                        lastModified: new Date(0).toISOString(),
                        views: 0,
                        attempts: 0,
                        timeSpentInSeconds: 0
                    },
                    subDecks: [],
                    parent: null,
                    additionalData: {}
                },
                serverUpdatedAt: new Date()
            }
        },
        { upsert: true }
    );

    // Badge celebrations queue on the blocking-overlay coordinator, so an
    // unacknowledged badge would sit in front of the tour the suite is trying
    // to drive. Acknowledge whatever the account has already earned.
    const storedUser = await database.collection("users").findOne({ id: TEST_ACCOUNT_ID });
    const additionalData = storedUser?.additionalData || {};

    const streakState = additionalData.streak || {};
    for (const earnedBadge of (streakState.earnedBadges || []))
    {
        earnedBadge.acknowledged = true;
    }

    const metricsState = additionalData.metrics || {};
    for (const badgeList of Object.values(metricsState.badges || {}))
    {
        for (const earnedBadge of badgeList)
        {
            earnedBadge.acknowledged = true;
        }
    }

    await database.collection("users").updateOne(
        { id: TEST_ACCOUNT_ID },
        { $set: { "additionalData.streak": streakState, "additionalData.metrics": metricsState } }
    );

    await client.close();

    // Printing the accepted versions matters: a "0 documents" line is the tell
    // that Dock has not booted against this database yet, so the account will
    // hit the terms gate the moment the seeder is trusted.
    const acceptedVersionSummary = Object.entries(acceptedLegalFields)
        .filter(([fieldKey]) => fieldKey.endsWith("Version"))
        .map(([fieldKey, version]) => `${fieldKey.replace(/^agreed|Version$/g, "")} v${version}`)
        .join(", ");

    console.log(`Seeded test account "${TEST_ACCOUNT_ID}" `
        + `(accepted: ${acceptedVersionSummary || "0 legal documents found — start Dock once against this database, then re-run"}).`);
    console.log("");
    console.log("Put this in deployment.env:");
    console.log(`  TUTORIAL_TEST_SESSION_COOKIE=${TEST_SESSION_ID}`);
})().catch(error =>
{
    console.error("Seeding failed:", error.message);
    process.exit(1);
});
