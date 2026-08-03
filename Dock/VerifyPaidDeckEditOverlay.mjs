/**
 * Verification harness for paid-deck editing.
 *
 * Paid content is stored as ciphertext envelopes and decrypted in memory only.
 * Rental expiry is enforced by KEY AVAILABILITY, not by a flag — so every
 * invariant this harness checks exists to keep exactly two things true at once:
 * a buyer can edit their own copy, and a lapsed license still takes the content
 * away.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckEditOverlay.mjs
 *
 * Tiers:
 *   1. Always on, pure in-process. No DB, no network, no Redis. Covers:
 *      • the envelope layout the browser and the server must agree on,
 *      • that a content overlay is NOT server-protected on push (an overlay is
 *        the learner's own edit, so protecting it would revert every edit) and
 *        passes through the pull's encrypt step unmodified,
 *      • the license-rotation invariant that all buyer-side encryption
 *        depends on.
 *   2. VERIFY_PAID_DECK_OVERLAY_ROTATION=1 — drives the real
 *      KeyManagementService.rotateKeysForDeck against MongoDB (reads Dock/.env)
 *      with a throwaway deck and user, and asserts a rotation changes only the
 *      master key. Cleans up everything it creates.
 *
 * Background on tier 1's subject. A DeckLicense carries TWO independent key
 * systems:
 *
 *   • keyVersion + wrappedKeyBlob — the MASTER asset key over the seller's
 *     master entities. rotateKeysForDeck rotates this.
 *   • contentKeyVersion + serverWrapped* + passwordWrapped* — the PER-LICENSE
 *     content key that encrypts paid content on the /Sync wire and at rest on
 *     the device. It has its own rotation path and a master-key rotation must
 *     not touch it.
 *
 * rotateKeysForDeck reissues through issueLicenseForUser, which builds a
 * brand-new DeckLicense with every field of the second system at its default;
 * persistLicense then writes the whole document. Without
 * LicenseFieldPreserver the rotation silently blanks the buyer's content key,
 * their paid-deck password material and the manage-copies registry — the buyer
 * can no longer unlock, and the /Sync pull withholds every paid entity from
 * them indefinitely.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

// A master key must exist before KeyManagementService will initialize. Tier 1
// only needs SOME valid 32-byte key; tier 2 replaces this with the real one
// from Dock/.env so it can read licenses the running server also reads.
if (!process.env.PAID_DECK_MASTER_KEY_BASE64)
{
    process.env.PAID_DECK_MASTER_KEY_BASE64 = crypto.randomBytes(32).toString("base64");
}

const LicenseFieldPreserver = require("./Globals/Classes/Security/LicenseFieldPreserver");
const PaidDeckSyncCrypto = require("./Globals/Classes/Security/PaidDeckSyncCrypto");
const { PAID_PROTECTED_TYPE_COLLECTIONS } = require("./Endpoints/Sync/Sync");
const { entityTypes } = require("./Globals/Enumerations/EntityTypes");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const DeckLicense = require("./Globals/Model/DeckLicense");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

// A content key wrapped under the master key, which is what
// issueLicenseForUser expects as input. In production this comes back from
// storeMasterEntitiesFromBatches (a database write); tier 1 must stay pure, so
// it builds a valid one directly. The envelope layout mirrors
// KeyManagementService's private #encryptBuffer exactly: AES-256-GCM, a
// 12-byte IV, and ciphertext||16-byte tag, both base64.
function wrapContentKeyUnderMasterKey()
{
    const masterKeyBuffer = Buffer.from(process.env.PAID_DECK_MASTER_KEY_BASE64, "base64");
    const contentKeyBuffer = crypto.randomBytes(32);
    const initializationVector = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv("aes-256-gcm", masterKeyBuffer, initializationVector);
    const ciphertext = Buffer.concat([cipher.update(contentKeyBuffer), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    contentKeyBuffer.fill(0);

    return {
        wrappedContentKeyIvBase64: initializationVector.toString("base64"),
        wrappedContentKeyBase64: Buffer.concat([ciphertext, authenticationTag]).toString("base64")
    };
}

/**
 * Builds a license the way rotateKeysForDeck does, with a validly wrapped
 * content key so issueLicenseForUser can unwrap it.
 */
function issueLicenseForVerification(userId, deckId, keyVersion)
{
    const wrapped = wrapContentKeyUnderMasterKey();
    return KeyManagementService.issueLicenseForUser
    (
        userId,
        deckId,
        keyVersion,
        wrapped.wrappedContentKeyIvBase64,
        wrapped.wrappedContentKeyBase64
    );
}

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

/**
 * The buyer-scoped fields a master-key rotation must never change, and the
 * values a fully-provisioned license carries for them.
 */
function buildBuyerScopedState()
{
    return {
        serverWrappedContentKeyBase64: "server-wrapped-content-key",
        serverWrappedIvBase64: "server-wrapped-iv",
        passwordWrappedContentKeyBase64: "password-wrapped-content-key",
        passwordWrappedIvBase64: "password-wrapped-iv",
        contentKeyVersion: 4,
        passwordHash: "stored-password-hash",
        passwordSalt: "stored-password-salt",
        downloadedContentVersion: 7,
        additionalData: { instances: [{ instanceId: "1", label: "Copy 1" }, { instanceId: "second", label: "Copy 2" }] }
    };
}

function verifyEnvelopeIsByteCompatibleWithTheClient()
{
    section("Tier 1 — the server and the browser speak the same envelope");

    // A learner's edit is encrypted in the BROWSER (PaidDeckSession.encryptString,
    // WebCrypto) and decrypted... never on the server — but the server DOES
    // re-encrypt seller content for the same client with this function. If the
    // two layouts ever diverge, paid content silently stops decrypting on the
    // device. This pins the layout the browser's decryptString expects:
    // a 12-byte IV, then ciphertext||16-byte GCM tag, both base64.
    const contentKeyBuffer = crypto.randomBytes(32);
    const plaintextValue = "<p>The learner's own note.</p>";

    const envelope = KeyManagementService.encryptPaidDeckFieldString(plaintextValue, contentKeyBuffer);

    const initializationVector = Buffer.from(envelope.ivBase64, "base64");
    const combinedCiphertext = Buffer.from(envelope.ciphertextBase64, "base64");

    assert(initializationVector.length === 12, "the IV is 12 bytes, as WebCrypto's AES-GCM expects");
    assert(combinedCiphertext.length >= 16, "the ciphertext carries the 16-byte GCM tag appended");

    // Decrypt exactly the way the browser does: split the tag off the tail.
    const authenticationTag = combinedCiphertext.subarray(combinedCiphertext.length - 16);
    const ciphertextOnly = combinedCiphertext.subarray(0, combinedCiphertext.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", contentKeyBuffer, initializationVector);
    decipher.setAuthTag(authenticationTag);
    const recoveredPlaintext = Buffer.concat([decipher.update(ciphertextOnly), decipher.final()]).toString("utf8");

    assert(recoveredPlaintext === plaintextValue, "the browser's tag-split decrypt recovers the server's ciphertext");

    const overlayShapedEnvelope = { __enc: 1, ivBase64: envelope.ivBase64, ciphertextBase64: envelope.ciphertextBase64 };
    assert(PaidDeckSyncCrypto.isEncryptedField(overlayShapedEnvelope),
        "an overlay's stored value is recognised as an encrypted field");
}

function verifyOverlaysAreNotServerProtected()
{
    section("Tier 1 — an overlay is buyer-authored and must survive the push");

    const protectedEntityTypes = PAID_PROTECTED_TYPE_COLLECTIONS.map(entry => entry.entityType);

    assert(!protectedEntityTypes.includes(entityTypes.CONTENT_OVERLAY),
        "CONTENT_OVERLAY is absent from the server-protected list — adding it would revert every edit on the next sync");
    assert(protectedEntityTypes.includes(entityTypes.CARD) && protectedEntityTypes.includes(entityTypes.STUDY_MATERIAL),
        "the seller-authored types are still protected, so a client cannot rewrite the original content");

    // The pull hands every paid entity to encryptEntityContent. An overlay's
    // value is already ciphertext, so it must come back untouched — a
    // CONTENT_OVERLAY branch there would double-encrypt it beyond recovery.
    const contentKeyBuffer = crypto.randomBytes(32);
    const overlayRecord =
    {
        id: "card-1::1",
        deckId: "deck-1",
        targetEntityId: "card-1",
        fieldKey: 1,
        value: { __enc: 1, ivBase64: "aXY=", ciphertextBase64: "Y3Q=" }
    };
    const passedThrough = PaidDeckSyncCrypto.encryptEntityContent(entityTypes.CONTENT_OVERLAY, overlayRecord, contentKeyBuffer);

    assert(passedThrough.value.ciphertextBase64 === "Y3Q=" && passedThrough.value.ivBase64 === "aXY=",
        "an overlay passes through the pull's encrypt step unmodified");
}

function verifyReissueAloneLosesBuyerState()
{
    section("Tier 1 — a bare reissue is exactly what the bug looked like");

    const reissued = issueLicenseForVerification("verify-user", "verify-deck", 2);

    assert(reissued.getServerWrappedContentKeyBase64() === "",
        "issueLicenseForUser alone returns no content key — this is why the preserver exists");
    assert(reissued.getPasswordHash() === "" && reissued.getPasswordSalt() === "",
        "issueLicenseForUser alone returns no paid-deck password material");
    assert(Object.keys(reissued.getAdditionalData()).length === 0,
        "issueLicenseForUser alone returns an empty additionalData (the copy registry)");

    const emittedJson = reissued.toJson();
    const buyerScopedFieldNames =
    [
        "serverWrappedContentKeyBase64", "serverWrappedIvBase64",
        "passwordWrappedContentKeyBase64", "passwordWrappedIvBase64",
        "contentKeyVersion", "passwordHash", "passwordSalt",
        "downloadedContentVersion", "additionalData"
    ];
    const everyFieldIsEmitted = buyerScopedFieldNames.every(fieldName => Object.prototype.hasOwnProperty.call(emittedJson, fieldName));

    assert(everyFieldIsEmitted,
        "toJson emits every buyer-scoped field, so persistLicense's whole-document $set would blank each one");
}

function verifyPreserverRestoresEveryBuyerScopedField()
{
    section("Tier 1 — the preserver restores every buyer-scoped field");

    const buyerScopedState = buildBuyerScopedState();
    const storedLicenseDocument =
    {
        userId: "verify-user",
        deckId: "verify-deck",
        status: deckLicenseStatuses.ACTIVE,
        keyVersion: 2,
        issuedAt: new Date("2026-01-05T00:00:00.000Z"),
        ...buyerScopedState
    };

    const reissued = issueLicenseForVerification("verify-user", "verify-deck", 3);
    const rotatedWrappedKeyBlob = reissued.getWrappedKeyBlob();

    LicenseFieldPreserver.carryForwardBuyerScopedFields(reissued, storedLicenseDocument);

    assert(reissued.getServerWrappedContentKeyBase64() === buyerScopedState.serverWrappedContentKeyBase64
        && reissued.getServerWrappedIvBase64() === buyerScopedState.serverWrappedIvBase64,
        "the server-wrapped content key survives — without it /Sync withholds every paid entity");
    assert(reissued.getPasswordWrappedContentKeyBase64() === buyerScopedState.passwordWrappedContentKeyBase64
        && reissued.getPasswordWrappedIvBase64() === buyerScopedState.passwordWrappedIvBase64,
        "the password-wrapped content key survives — without it the buyer can never unlock again");
    assert(reissued.getContentKeyVersion() === buyerScopedState.contentKeyVersion,
        "contentKeyVersion does not move: a master-key rotation is not a content-key rotation");
    assert(reissued.getPasswordHash() === buyerScopedState.passwordHash
        && reissued.getPasswordSalt() === buyerScopedState.passwordSalt,
        "the paid-deck password material survives");
    assert(reissued.getDownloadedContentVersion() === buyerScopedState.downloadedContentVersion,
        "the content version the buyer's copies were seeded from survives");
    assert(Array.isArray(reissued.getAdditionalData().instances) && reissued.getAdditionalData().instances.length === 2,
        "the manage-copies instance registry survives");
    assert(reissued.getIssuedAt().getTime() === new Date("2026-01-05T00:00:00.000Z").getTime(),
        "issuedAt stays at the acquisition date — a rotation is not a new grant");

    assert(reissued.getKeyVersion() === 3 && reissued.getWrappedKeyBlob() === rotatedWrappedKeyBlob,
        "the rotated master key and its version are NOT reverted — the rotation still does its job");
}

function verifyPreserverToleratesLegacyDocuments()
{
    section("Tier 1 — legacy and malformed stored documents");

    const legacyReissue = issueLicenseForVerification("verify-user", "verify-deck", 2);
    LicenseFieldPreserver.carryForwardBuyerScopedFields(legacyReissue, { userId: "verify-user", deckId: "verify-deck" });

    assert(legacyReissue.getServerWrappedContentKeyBase64() === "" && legacyReissue.getContentKeyVersion() === 0,
        "a license predating the content-key fields yields model defaults, never undefined");

    const malformedReissue = new DeckLicense({ userId: "verify-user", deckId: "verify-deck" });
    LicenseFieldPreserver.carryForwardBuyerScopedFields(malformedReissue, { additionalData: ["instances"] });

    assert(!Array.isArray(malformedReissue.getAdditionalData()),
        "an array additionalData is coerced to an object rather than persisted as a broken registry");
}

async function verifyRotationAgainstDatabase()
{
    section("Tier 2 — a real rotation against MongoDB");

    if (process.env.VERIFY_PAID_DECK_OVERLAY_ROTATION !== "1")
    {
        skip("MongoDB rotation round-trip (set VERIFY_PAID_DECK_OVERLAY_ROTATION=1 to run)");
        return;
    }

    // This tier WRITES (a throwaway deck, master entities and a license), so it
    // must never be pointed at production. Dock resolves its env file by
    // environment name and only "local" falls back to Dock/.env — production
    // lives in Dock/.production.env — so loading that file is already the local
    // choice. The explicit refusal below makes it a guarantee rather than an
    // accident of file naming, for the case where someone exports
    // COGNIUMLEARN_ENVIRONMENT before running this.
    const configuredEnvironmentName = String(process.env.COGNIUMLEARN_ENVIRONMENT || "local").trim().toLowerCase();
    if (configuredEnvironmentName === "production")
    {
        skip("MongoDB rotation round-trip — refusing to run against production (COGNIUMLEARN_ENVIRONMENT=production)");
        return;
    }

    require("dotenv").config({ path: path.join(currentDirectory, ".local.env") });
    require("dotenv").config({ path: path.join(currentDirectory, ".env") });

    if (!process.env.MONGODB_URL)
    {
        skip("MongoDB rotation round-trip — MONGODB_URL is not set in Dock/.local.env or Dock/.env");
        return;
    }

    const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
    const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB rotation round-trip — database unreachable: ${connectionError.message}`);
        return;
    }

    if (!database)
    {
        skip("MongoDB rotation round-trip — database unreachable");
        return;
    }

    const throwawayDeckId = `verify-overlay-deck-${crypto.randomUUID()}`;
    const throwawayUserId = `verify-overlay-user-${crypto.randomUUID()}`;
    const buyerScopedState = buildBuyerScopedState();

    try
    {
        const contentKeyBytes = KeyManagementService.generatePaidDeckContentKey();
        const masterPayload = { id: throwawayDeckId, name: "Verify overlay deck", cards: [], studyMaterials: [], mockTests: [], subDecks: [] };
        const storeResult = await KeyManagementService.storePaidDeckMaster(throwawayDeckId, 1, masterPayload);
        contentKeyBytes.fill(0);

        if (!storeResult || !storeResult.wrappedContentKeyBase64)
        {
            skip("MongoDB rotation round-trip — could not store a throwaway master");
            return;
        }

        await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .insertOne({ id: throwawayDeckId, title: "Verify overlay deck", keyVersion: 1, isPublished: false, contentSummary: { contentVersion: 1 } });

        const seededLicense = KeyManagementService.issueLicenseForUser
        (
            throwawayUserId,
            throwawayDeckId,
            1,
            storeResult.wrappedContentKeyIvBase64,
            storeResult.wrappedContentKeyBase64
        );
        LicenseFieldPreserver.carryForwardBuyerScopedFields(seededLicense, buyerScopedState);
        await KeyManagementService.persistLicense(seededLicense);

        const rotationResult = await KeyManagementService.rotateKeysForDeck(throwawayDeckId);
        assert(rotationResult && rotationResult.success === true, "rotateKeysForDeck reports success");

        const rotatedDocument = await database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .findOne({ userId: throwawayUserId, deckId: throwawayDeckId });

        assert(rotatedDocument !== null, "the rotated license is still present");
        assert(rotatedDocument.keyVersion === 2, "the master key version advanced");
        assert(rotatedDocument.serverWrappedContentKeyBase64 === buyerScopedState.serverWrappedContentKeyBase64,
            "the stored server-wrapped content key survived a real rotation");
        assert(rotatedDocument.passwordHash === buyerScopedState.passwordHash
            && rotatedDocument.passwordSalt === buyerScopedState.passwordSalt,
            "the stored paid-deck password material survived a real rotation");
        assert(rotatedDocument.contentKeyVersion === buyerScopedState.contentKeyVersion,
            "the stored contentKeyVersion did not move");
        assert(Array.isArray(rotatedDocument.additionalData?.instances) && rotatedDocument.additionalData.instances.length === 2,
            "the stored manage-copies registry survived a real rotation");

        const resolvedContentKey = await KeyManagementService.getPaidDeckContentKeyBufferForUser(throwawayUserId, throwawayDeckId);
        assert(resolvedContentKey !== null,
            "the server can still resolve a content key after rotation — this is what decides whether /Sync delivers or withholds");
        if (resolvedContentKey)
        {
            resolvedContentKey.fill(0);
        }
    }
    finally
    {
        for (const cleanupOperation of
        [
            () => database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION).deleteMany({ deckId: throwawayDeckId }),
            () => database.collection(DatabaseConstants.PAID_DECKS_COLLECTION).deleteMany({ id: throwawayDeckId }),
            () => database.collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION).deleteMany({ deckId: throwawayDeckId }),
            () => database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION).deleteMany({ deckId: throwawayDeckId })
        ])
        {
            try
            {
                await cleanupOperation();
            }
            catch (cleanupError)
            {
                console.warn(`  WARN  cleanup step failed: ${cleanupError.message}`);
            }
        }

        try
        {
            await DatabaseConnector.close();
        }
        catch (closeError)
        {
            // Nothing to do — the process is about to exit.
        }
    }
}

async function main()
{
    verifyEnvelopeIsByteCompatibleWithTheClient();
    verifyOverlaysAreNotServerProtected();
    verifyReissueAloneLosesBuyerState();
    verifyPreserverRestoresEveryBuyerScopedField();
    verifyPreserverToleratesLegacyDocuments();
    await verifyRotationAgainstDatabase();

    console.log("\n=== Summary ===");
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);
    console.log(`  skipped: ${skippedCount}`);

    process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((fatalError) =>
{
    console.error("Verification harness crashed:", fatalError);
    process.exit(1);
});
