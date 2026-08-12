/**
 * End-to-end verification harness for AccountMergeService — folding a
 * duplicate (split-identity) account into its canonical survivor.
 *
 * Run from the Dock directory:
 *     node VerifyAccountMerge.mjs
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks: AccountMergeCollectionPlan's
 *      completeness against the collections this codebase actually keys by
 *      userId, and AccountMergeService.isMorePermissiveLicense's decision
 *      logic. No network, no DB.
 *
 *   2. DB (opt-in: VERIFY_ACCOUNT_MERGE_DB=1) — drives the real
 *      AccountMergeService end to end against the configured MongoDB: root
 *      deck collision + holding-deck reparenting, credit summing, device
 *      fingerprint collision, session migration, and — the highest-stakes
 *      check — that a transferred paid-deck license actually round-trips
 *      through the real KeyManagementService to the correct plaintext
 *      content key, not just that a Mongo document's userId field changed.
 *      Also asserts idempotency (re-running a completed merge is a no-op)
 *      and that AccountIdentityResolver forwards a merged-away id to the
 *      survivor on a subsequent login. Creates throwaway *.invalid
 *      accounts and a throwaway paid-deck fixture, all cleaned up after.
 *      Skips (not fails) when the flag is off or Mongo is down.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const AccountMergeCollectionPlan = require("./Globals/Classes/Authentication/AccountMergeCollectionPlan");
const AccountMergeService = require("./Globals/Classes/Authentication/AccountMergeService");
const AccountIdentityResolver = require("./Globals/Classes/Authentication/AccountIdentityResolver");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const User = require("./Globals/Model/User");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const { authenticationProviders } = require("./Globals/Enumerations/AuthenticationProviders");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");

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

// ── Tier 1 ───────────────────────────────────────────────────────────────

function runAlwaysOnTier()
{
    section("Tier 1 — merge logic (always on)");

    // The collections this codebase keys by userId (excluding the audit
    // trails that are deliberately never repointed, and userDailyActivity,
    // which is keyed by scopeKey and handled by its own special step) —
    // hand-verified against Dock/Globals/Classes/Database/DatabaseConnector.js
    // when this plan was written. A collection added later that is not on
    // this list, and not in AccountMergeCollectionPlan.PLAN, would leave a
    // merged-away account's rows silently unreachable forever.
    const collectionsThatMustBeCovered =
    [
        DatabaseConstants.DECKS_COLLECTION, DatabaseConstants.CARDS_COLLECTION, DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        DatabaseConstants.MOCK_TESTS_COLLECTION, DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION, DatabaseConstants.CONTENT_OVERLAYS_COLLECTION,
        DatabaseConstants.DELETIONS_COLLECTION, DatabaseConstants.SYNC_DATA_COLLECTION, DatabaseConstants.INFORMATION_SOURCES_COLLECTION,
        DatabaseConstants.TEXT_EMBEDDINGS_COLLECTION, DatabaseConstants.FIGURES_COLLECTION, DatabaseConstants.GENERATION_TEMPLATES_COLLECTION,
        DatabaseConstants.PURCHASES_COLLECTION, DatabaseConstants.DECK_LICENSES_COLLECTION, DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION,
        DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION, DatabaseConstants.DEVICES_COLLECTION, DatabaseConstants.SESSIONS_COLLECTION,
        DatabaseConstants.UPLOAD_QUOTAS_COLLECTION, DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION, DatabaseConstants.TASK_STATES_COLLECTION,
        DatabaseConstants.TASK_HISTORY_COLLECTION, DatabaseConstants.PUSH_TOKENS_COLLECTION, DatabaseConstants.NOTIFICATIONS_COLLECTION,
        DatabaseConstants.PROMO_CODE_REDEMPTIONS_COLLECTION, DatabaseConstants.SCREENSHOT_EVENTS_COLLECTION, DatabaseConstants.AI_GENERATED_EXPORT_EVENTS_COLLECTION,
        DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION, DatabaseConstants.SUPPORT_TICKET_REPORTS_COLLECTION, DatabaseConstants.USER_SUBSCRIPTIONS_COLLECTION,
    ];
    const planCollectionNames = new Set(AccountMergeCollectionPlan.PLAN.map((entry) => entry.collectionName));
    const missingFromPlan = collectionsThatMustBeCovered.filter((collectionName) => !planCollectionNames.has(collectionName));
    assert(missingFromPlan.length === 0, `Every known userId-keyed collection is covered by AccountMergeCollectionPlan (missing: ${missingFromPlan.join(", ") || "none"})`);
    assert(planCollectionNames.has(DatabaseConstants.DECKS_COLLECTION) && planCollectionNames.has(DatabaseConstants.DECK_LICENSES_COLLECTION), "The plan names the two highest-risk collections (decks, deckLicenses)");

    // isMorePermissiveLicense: active beats inactive, forever beats dated,
    // later expiry beats earlier — regardless of argument order.
    const activeForever = { status: deckLicenseStatuses.ACTIVE, expiresAt: null };
    const activeDated = { status: deckLicenseStatuses.ACTIVE, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
    const activeDatedSooner = { status: deckLicenseStatuses.ACTIVE, expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() };
    const revoked = { status: deckLicenseStatuses.REVOKED !== undefined ? deckLicenseStatuses.REVOKED : 0, expiresAt: null };

    assert(AccountMergeService.isMorePermissiveLicense(activeForever, activeDated) === true, "An active, never-expiring license beats an active dated one");
    assert(AccountMergeService.isMorePermissiveLicense(activeDated, activeForever) === false, "...regardless of argument order");
    assert(AccountMergeService.isMorePermissiveLicense(activeDated, activeDatedSooner) === true, "Between two dated active licenses, the later expiry wins");
    assert(AccountMergeService.isMorePermissiveLicense(activeDated, revoked) === true, "An active license always beats a non-active one");
    assert(AccountMergeService.isMorePermissiveLicense(revoked, activeDated) === false, "...regardless of argument order");

    // Synchronous-merge ceiling exists and is a sane positive number — a
    // regression here (e.g. 0, or accidentally deleted) would make every
    // account defer forever.
    assert(typeof AccountMergeService.SYNCHRONOUS_MERGE_ENTITY_CEILING === "number" && AccountMergeService.SYNCHRONOUS_MERGE_ENTITY_CEILING > 0, "A positive synchronous-merge entity ceiling is configured");
}

// ── Tier 2 ───────────────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("Tier 2 — real merge against MongoDB (opt-in: VERIFY_ACCOUNT_MERGE_DB=1)");

    if (process.env.VERIFY_ACCOUNT_MERGE_DB !== "1")
    {
        skip("DB tier disabled (set VERIFY_ACCOUNT_MERGE_DB=1 to run the real merge)");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("MongoDB is not reachable (MONGODB_URL not set / server down) — DB tier skipped");
        return;
    }

    const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");

    const runTag = Date.now();
    const testEmail = `verify-account-merge-${runTag}@cogniumlearn.invalid`;
    const survivorId = `verify-merge-survivor-${runTag}`;
    const loserId = `verify-merge-google-sub-${runTag}`;
    const deckIdNoCollision = `verify-merge-deck-clean-${runTag}`;
    const deckIdCollision = `verify-merge-deck-collision-${runTag}`;
    const sharedFingerprintHash = `verify-merge-fingerprint-${runTag}`;

    // Declared here (not down where they are actually assigned, inside the
    // try block below) specifically so the finally block can see them —
    // `finally {}` is a SIBLING scope of `try {}`, not a nested one, so a
    // const declared inside try is invisible to finally and every cleanup
    // line referencing it would silently no-op behind its own try/catch.
    const seededUserIds = [survivorId, loserId];
    const seededDeckFixtureIds = [deckIdNoCollision, deckIdCollision];
    const survivorDeviceId = crypto.randomUUID();
    const loserDeviceId = crypto.randomUUID();
    const loserSessionId = crypto.randomUUID();

    const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
    const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
    const cardsCollection = database.collection(DatabaseConstants.CARDS_COLLECTION);
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
    const devicesCollection = database.collection(DatabaseConstants.DEVICES_COLLECTION);
    const sessionsCollection = database.collection(DatabaseConstants.SESSIONS_COLLECTION);
    const paidDeckAssetsCollection = database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION);

    console.log(`  info  Using database "${process.env.MONGODB_DATABASE_NAME}" — creating throwaway *.invalid accounts`);

    // Wraps fixture creation as well as the merge + assertions — a failure
    // anywhere in setup must still reach the cleanup below, or a fixture
    // that fails to seed correctly leaks throwaway rows into this database
    // forever instead of just failing this run.
    try
    {

    // ── Fixture: master asset rows (empty content — AccountMergeService's
    // transfer step reads these via KeyManagementService.getMasterMeta only
    // to rebuild the legacy, never-read-in-production wrappedKeyBlob field
    // for hygiene; it needs the row to EXIST, not to hold any real entities).
    async function* noEntityBatches()
    {
        // Yields nothing on purpose.
    }
    await KeyManagementService.storeMasterEntitiesFromBatches(deckIdNoCollision, 1, { rootDeckId: "", entries: [] }, noEntityBatches());
    await KeyManagementService.storeMasterEntitiesFromBatches(deckIdCollision, 1, { rootDeckId: "", entries: [] }, noEntityBatches());

    // ── Fixture: the ACTUAL per-license content keys — independently
    // generated and wrapped under the deck's server KEK, exactly like a real
    // purchase grant (PaidDeckGrantHelpers.js), never derived from the
    // master asset above (they are deliberately unrelated keys).
    const cleanContentKey = KeyManagementService.generatePaidDeckContentKey();
    const cleanWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(cleanContentKey, deckIdNoCollision);
    const collisionLoserContentKey = KeyManagementService.generatePaidDeckContentKey();
    const collisionLoserWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(collisionLoserContentKey, deckIdCollision);
    const collisionSurvivorContentKey = KeyManagementService.generatePaidDeckContentKey();
    const collisionSurvivorWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(collisionSurvivorContentKey, deckIdCollision);

    // ── Fixture: two users sharing one email, survivor older ───────────────
    const survivorUser = new User
    ({
        id: survivorId, displayName: "Merge Survivor", provider: authenticationProviders.EMAIL_OTP,
        joinDate: new Date(runTag - (60 * 24 * 60 * 60 * 1000)), preferences: {},
        additionalData: { email: testEmail, credits: 100, lifetimeCreditsSpent: 20 }
    });
    const loserUser = new User
    ({
        id: loserId, displayName: "Merge Loser", provider: authenticationProviders.GOOGLE,
        joinDate: new Date(runTag), preferences: {},
        additionalData: { email: testEmail, credits: 50, lifetimeCreditsSpent: 5 }
    });
    // Seeded via a direct insert, not AuthenticationQueryEngine.createUser —
    // that now correctly derives+writes normalizedEmail, and with the
    // unique index active a second createUser for the same email would
    // fail outright (exactly the protection working as intended for NEW
    // accounts). The scenario under test is a LEGACY split that predates
    // that protection, so it has to be seeded the way old data actually
    // looks: no normalizedEmail agreement enforced between the two rows.
    await usersCollection.insertOne(survivorUser.toJson());
    await usersCollection.insertOne(loserUser.toJson());

    // ── Fixture: deck trees, both with their own root "0" ──────────────────
    const now = new Date();
    await decksCollection.insertMany
    ([
        { userId: survivorId, serverUpdatedAt: now, data: { id: "0", name: "Root", shortName: "Root", tags: [], parent: null, lifecycle: { lastModified: now.toISOString() }, additionalData: {} } },
        { userId: survivorId, serverUpdatedAt: now, data: { id: `survivor-deck-${runTag}`, name: "Survivor Deck", shortName: "SurvivorDeck", tags: [], parent: "0", lifecycle: { lastModified: now.toISOString() }, additionalData: {} } },
        { userId: loserId, serverUpdatedAt: now, data: { id: "0", name: "Root", shortName: "Root", tags: [], parent: null, lifecycle: { lastModified: now.toISOString() }, additionalData: {} } },
        { userId: loserId, serverUpdatedAt: now, data: { id: `loser-deck-${runTag}`, name: "Loser Deck", shortName: "LoserDeck", tags: [], parent: "0", lifecycle: { lastModified: now.toISOString() }, additionalData: {} } },
    ]);
    await cardsCollection.insertMany
    ([
        { userId: survivorId, serverUpdatedAt: now, data: { id: `survivor-card-${runTag}`, deckId: `survivor-deck-${runTag}`, question: "Q", answer: "A", lifecycle: { lastModified: now.toISOString() } } },
        { userId: loserId, serverUpdatedAt: now, data: { id: `loser-card-${runTag}`, deckId: `loser-deck-${runTag}`, question: "Q", answer: "A", lifecycle: { lastModified: now.toISOString() } } },
    ]);

    // ── Fixture: paid-deck licenses — one clean transfer, one collision ────
    // Built directly with the real server-wrapped content key fields
    // (mirroring PaidDeckGrantHelpers' actual grant flow) rather than via
    // issueLicenseForUser, which only ever populates the separate, legacy
    // wrappedKeyBlob field — not serverWrappedContentKeyBase64, the one
    // getPaidDeckContentKeyBufferForUser actually reads.
    const DeckLicense = require("./Globals/Model/DeckLicense");

    const cleanLicense = new DeckLicense
    ({
        userId: loserId, deckId: deckIdNoCollision, status: deckLicenseStatuses.ACTIVE, keyVersion: 1,
        expiresAt: null, grantSource: "TEST",
        serverWrappedIvBase64: cleanWrap.ivBase64, serverWrappedContentKeyBase64: cleanWrap.ciphertextBase64, contentKeyVersion: 1
    });
    await KeyManagementService.persistLicense(cleanLicense);

    // Collision: the loser's license is strictly more permissive (active +
    // forever) than the survivor's (active + expires soon), so the merge
    // should transfer the LOSER's key, not keep the survivor's weaker one —
    // the more interesting of the two collision branches.
    const collisionLoserLicense = new DeckLicense
    ({
        userId: loserId, deckId: deckIdCollision, status: deckLicenseStatuses.ACTIVE, keyVersion: 1,
        expiresAt: null, grantSource: "TEST",
        serverWrappedIvBase64: collisionLoserWrap.ivBase64, serverWrappedContentKeyBase64: collisionLoserWrap.ciphertextBase64, contentKeyVersion: 1
    });
    await KeyManagementService.persistLicense(collisionLoserLicense);

    const collisionSurvivorLicense = new DeckLicense
    ({
        userId: survivorId, deckId: deckIdCollision, status: deckLicenseStatuses.ACTIVE, keyVersion: 1,
        expiresAt: new Date(runTag + 5 * 24 * 60 * 60 * 1000), grantSource: "TEST",
        serverWrappedIvBase64: collisionSurvivorWrap.ivBase64, serverWrappedContentKeyBase64: collisionSurvivorWrap.ciphertextBase64, contentKeyVersion: 1
    });
    await KeyManagementService.persistLicense(collisionSurvivorLicense);

    // ── Fixture: same physical device registered under both accounts ──────
    await devicesCollection.insertMany
    ([
        { id: survivorDeviceId, userId: survivorId, deviceName: "Shared Machine (old)", platform: 0, userAgent: "", createdAt: now, lastSeenDate: new Date(runTag - 60000), lastSyncDate: now, publicKeyFingerprint: "", fingerprintHash: sharedFingerprintHash, additionalData: {} },
        { id: loserDeviceId, userId: loserId, deviceName: "Shared Machine (new)", platform: 0, userAgent: "", createdAt: now, lastSeenDate: now, lastSyncDate: now, publicKeyFingerprint: "", fingerprintHash: sharedFingerprintHash, additionalData: {} },
    ]);

    // ── Fixture: a session on the loser's (more-recently-seen) device ──────
    await sessionsCollection.insertOne
    ({
        id: loserSessionId, userId: loserId, provider: authenticationProviders.GOOGLE, deviceId: loserDeviceId,
        createdDate: now, lastRefreshDate: now, expirationDate: new Date(runTag + 30 * 24 * 60 * 60 * 1000)
    });

    const mergedUser = await AccountMergeService.mergeAccounts(survivorUser, loserUser, { triggerContext: "TEST" });
        assert(mergedUser !== null && mergedUser.getId() === survivorId, "mergeAccounts returns the reloaded survivor");

        // Deck tree
        const loserDeckCountAfter = await decksCollection.countDocuments({ userId: loserId });
        assert(loserDeckCountAfter === 0, "No deck rows remain under the loser id after the merge");

        const loserDeckDocumentAfter = await decksCollection.findOne({ userId: survivorId, "data.id": `loser-deck-${runTag}` });
        assert(loserDeckDocumentAfter !== null, "The loser's non-root deck was repointed onto the survivor");

        const holdingDeckDocument = await decksCollection.findOne({ userId: survivorId, [`data.additionalData.accountMergeSourceUserId`]: loserId });
        assert(holdingDeckDocument !== null, "A holding deck was created under the survivor, marked with the loser's id");
        assert(loserDeckDocumentAfter && loserDeckDocumentAfter.data.parent === holdingDeckDocument.data.id, "The loser's top-level deck was reparented onto the holding deck, not the survivor's literal root");

        const survivorRootStillSingular = await decksCollection.countDocuments({ userId: survivorId, "data.id": "0" });
        assert(survivorRootStillSingular === 1, "The survivor still has exactly one root deck (no id collision from the merge)");

        const loserCardDocumentAfter = await cardsCollection.findOne({ userId: survivorId, "data.id": `loser-card-${runTag}` });
        assert(loserCardDocumentAfter !== null, "The loser's card was repointed onto the survivor");

        // Credits
        const survivorUserDocumentAfter = await usersCollection.findOne({ id: survivorId });
        assert(survivorUserDocumentAfter.additionalData.credits === 150, `Credits were summed onto the survivor (expected 150, got ${survivorUserDocumentAfter.additionalData.credits})`);
        assert(survivorUserDocumentAfter.additionalData.lifetimeCreditsSpent === 25, `lifetimeCreditsSpent was summed onto the survivor (expected 25, got ${survivorUserDocumentAfter.additionalData.lifetimeCreditsSpent})`);

        // License — clean transfer, and the DEFINITIVE decryptability check
        const cleanLicenseAfter = await licensesCollection.findOne({ userId: survivorId, deckId: deckIdNoCollision });
        assert(cleanLicenseAfter !== null, "The cleanly-transferred license now belongs to the survivor");
        const cleanLicenseUnderLoserAfter = await licensesCollection.findOne({ userId: loserId, deckId: deckIdNoCollision });
        assert(cleanLicenseUnderLoserAfter === null, "The original license row under the loser id is gone (not duplicated)");

        const decryptedCleanKey = await KeyManagementService.getPaidDeckContentKeyBufferForUser(survivorId, deckIdNoCollision);
        assert(decryptedCleanKey !== null && Buffer.isBuffer(decryptedCleanKey) && decryptedCleanKey.equals(cleanContentKey),
            "CRITICAL: the transferred license decrypts to the exact original content key under the survivor's id — real KeyManagementService round-trip, not just a Mongo field change");

        // License — collision, loser's (more permissive) license should win
        const collisionLicensesForSurvivor = await licensesCollection.find({ userId: survivorId, deckId: deckIdCollision }).toArray();
        assert(collisionLicensesForSurvivor.length === 1, `Exactly one license remains for the collided deck under the survivor (found ${collisionLicensesForSurvivor.length})`);
        const collisionLicenseUnderLoserAfter = await licensesCollection.findOne({ userId: loserId, deckId: deckIdCollision });
        assert(collisionLicenseUnderLoserAfter === null, "The loser's copy of the collided license is gone");

        const decryptedCollisionKey = await KeyManagementService.getPaidDeckContentKeyBufferForUser(survivorId, deckIdCollision);
        assert(decryptedCollisionKey !== null && decryptedCollisionKey.equals(collisionLoserContentKey) && !decryptedCollisionKey.equals(collisionSurvivorContentKey),
            "On collision, the MORE PERMISSIVE (loser's forever) license won and decrypts correctly — the weaker survivor license was discarded, not kept by default");

        // Devices — the more-recently-seen row (the loser's) should survive
        const devicesForFingerprintAfter = await devicesCollection.find({ fingerprintHash: sharedFingerprintHash }).toArray();
        assert(devicesForFingerprintAfter.length === 1, `Exactly one device row remains for the shared fingerprint (found ${devicesForFingerprintAfter.length})`);
        assert(devicesForFingerprintAfter[0] && devicesForFingerprintAfter[0].id === loserDeviceId && devicesForFingerprintAfter[0].userId === survivorId,
            "The more-recently-seen device (the loser's) survived, repointed onto the survivor");

        // Sessions — migrated in place
        const loserSessionAfter = await sessionsCollection.findOne({ id: loserSessionId });
        assert(loserSessionAfter !== null && loserSessionAfter.userId === survivorId, "The loser's session now belongs to the survivor (migrated in place, not invalidated)");

        // Tombstone, not hard delete
        const loserUserDocumentAfter = await usersCollection.findOne({ id: loserId });
        assert(loserUserDocumentAfter !== null, "The loser's user row still exists (tombstoned, not hard-deleted)");
        assert(loserUserDocumentAfter.additionalData?.mergedIntoUserId === survivorId, "The loser's row is stamped with mergedIntoUserId pointing at the survivor");

        // Idempotency — re-running against the now-tombstoned loser is a no-op
        const loserUserReloaded = await AuthenticationQueryEngine.getUserById(loserId);
        const secondMergeResult = await AccountMergeService.mergeAccounts(survivorUser, loserUserReloaded, { triggerContext: "TEST_RETRY" });
        assert(secondMergeResult !== null && secondMergeResult.getId() === survivorId, "Re-running the merge on an already-tombstoned loser returns the survivor without error");
        const survivorUserDocumentAfterRetry = await usersCollection.findOne({ id: survivorId });
        assert(survivorUserDocumentAfterRetry.additionalData.credits === 150, "Credits were NOT double-summed on the idempotent retry");

        // AccountIdentityResolver forwarding — a future login via the
        // merged-away id must redirect to the survivor, not resurrect it.
        const canonicalFromLoser = await AccountIdentityResolver.resolveCanonicalUser(loserUserReloaded);
        assert(canonicalFromLoser !== null && canonicalFromLoser.getId() === survivorId, "resolveCanonicalUser follows the tombstone from the loser id to the survivor");

        const futureGoogleLoginResolution = await AccountIdentityResolver.resolveAccountForLogin(loserId, testEmail, authenticationProviders.GOOGLE);
        assert(futureGoogleLoginResolution !== null && futureGoogleLoginResolution.getId() === survivorId, "A future Google login carrying the merged-away sub resolves straight to the survivor");
    }
    finally
    {
        try { await decksCollection.deleteMany({ userId: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await cardsCollection.deleteMany({ userId: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await licensesCollection.deleteMany({ userId: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await devicesCollection.deleteMany({ id: { $in: [survivorDeviceId, loserDeviceId] } }); } catch (cleanupError) { }
        try { await sessionsCollection.deleteMany({ id: loserSessionId }); } catch (cleanupError) { }
        try { await paidDeckAssetsCollection.deleteMany({ deckId: { $in: seededDeckFixtureIds } }); } catch (cleanupError) { }
        try { await usersCollection.deleteMany({ id: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_COLLECTION).deleteMany({ userId: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.PAID_DECK_USER_CONTENT_ENTITIES_COLLECTION).deleteMany({ userId: { $in: seededUserIds } }); } catch (cleanupError) { }
        try { await database.collection(DatabaseConstants.ACCOUNT_MERGE_LOCKS_COLLECTION).deleteMany({ id: testEmail }); } catch (cleanupError) { }
        try { await DatabaseConnector.getMongoClient()?.close(); } catch (closeError) { }
    }
}

async function main()
{
    console.log("CogniumLearn — account merge verification\n");

    runAlwaysOnTier();
    await runDatabaseTier();

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
