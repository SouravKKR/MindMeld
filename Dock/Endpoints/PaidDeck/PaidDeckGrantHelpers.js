const crypto = require("crypto");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckContentFingerprint = require("../../Globals/Classes/PaidDeck/PaidDeckContentFingerprint");
const { deckLicenseStatuses } = require("../../Globals/Enumerations/DeckLicenseStatuses");
const PaidDeckScopeResolver = require("../../Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const PaidDeckAudienceResolver = require("../../Globals/Classes/PaidDeck/PaidDeckAudienceResolver");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// The buyer's root deck id — a freshly provisioned paid deck attaches its
// bundle root under this so it appears as a top-level deck in the buyer's tree.
const USER_ROOT_DECK_ID = "0";

/**
 * Remaps a master entity id to a per-buyer id for the seeded copy. The master
 * content reuses the author's original deck/card ids, so seeding them verbatim
 * into the buyer's normal collections collides with any deck the buyer already
 * owns that shares those ids (most commonly the author buying their own deck,
 * but possible whenever ids overlap) — which trips the unique
 * userId_1_data.id_1 index. Deriving the id from (paidDeckId, scopeKey, masterId)
 * makes the buyer's copy collision-free AND deterministic, so a re-seed
 * produces identical ids (idempotent). Internal references (deck.parent,
 * card/material/mockTest.deckId) are remapped through the SAME function so the
 * tree stays internally consistent.
 *
 * The instanceId discriminator lets ONE buyer own several independent copies
 * of the same paid deck (detached progress, identical content). The original
 * copy (FIRST_INSTANCE_ID) deliberately reuses the legacy three-part hash so
 * decks seeded before multi-copy support keep their exact ids — additional
 * copies fold the instanceId into the hash so their entire subtree gets a
 * distinct, collision-free id space.
 */
function remapPaidEntityId(masterEntityId, scopeKey, paidDeckId, instanceId)
{
    if (typeof masterEntityId !== "string" || masterEntityId.length === 0)
    {
        return masterEntityId;
    }
    const isFirstInstance = instanceId === undefined
        || instanceId === null
        || instanceId === LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID;
    const hashInput = isFirstInstance
        ? `${paidDeckId}|${scopeKey}|${masterEntityId}`
        : `${paidDeckId}|${scopeKey}|${instanceId}|${masterEntityId}`;
    const digest = crypto.createHash("sha256").update(hashInput).digest("hex");
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Idempotently records the instance in the license's additionalData.instances
 * registry, which syncs to the client (PaidDeckRegistry) so the manage-copies
 * UI can enumerate copies without walking the deck tree. A license seeded
 * before multi-copy support has no instances array — when it is extended with
 * a NEW copy we first materialize the implicit original copy (its remapped
 * root matches the existing legacy rows because FIRST_INSTANCE_ID reuses the
 * legacy hash). Does NOT persist — the caller persists once after seeding.
 */
function registerInstanceOnLicense(license, deckId, scopeKey, masterRootDeckId, instanceId, instanceLabel)
{
    const additionalData = (license.getAdditionalData() && typeof license.getAdditionalData() === "object")
        ? license.getAdditionalData()
        : {};
    let instances = Array.isArray(additionalData.instances) ? additionalData.instances : [];

    if (instances.length === 0 && instanceId !== LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID)
    {
        instances.push
        ({
            instanceId: LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID,
            rootDeckId: remapPaidEntityId(masterRootDeckId, scopeKey, deckId, LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID),
            label: "Copy 1",
            createdAt: new Date().toISOString()
        });
    }

    const remappedRootDeckId = remapPaidEntityId(masterRootDeckId, scopeKey, deckId, instanceId);
    instances = instances.filter((entry) => entry && entry.instanceId !== instanceId);
    instances.push
    ({
        instanceId: instanceId,
        rootDeckId: remappedRootDeckId,
        label: instanceLabel,
        createdAt: new Date().toISOString()
    });

    additionalData.instances = instances;
    license.setAdditionalData(additionalData);
}

/**
 * Removes a copy from the license's instances registry (does NOT persist —
 * the caller persists). Safe on a license that never had the array (legacy
 * single-copy grant) — it just normalizes to an empty array.
 */
function removeInstanceFromLicense(license, instanceId)
{
    const additionalData = (license.getAdditionalData() && typeof license.getAdditionalData() === "object")
        ? license.getAdditionalData()
        : {};
    const instances = Array.isArray(additionalData.instances) ? additionalData.instances : [];
    additionalData.instances = instances.filter((entry) => entry && entry.instanceId !== instanceId);
    license.setAdditionalData(additionalData);
    return additionalData.instances;
}

/**
 * The Mongo filter that selects exactly ONE copy's seeded rows for a buyer.
 * The original copy (FIRST_INSTANCE_ID) also matches legacy rows written
 * before per-instance tagging existed (which carry no paidDeckInstanceId), so
 * a re-seed / delete of the original copy still sweeps them; additional copies
 * match only their own tagged rows and never touch siblings.
 */
function buildPaidInstanceRowFilter(scopeKey, deckId, instanceId)
{
    if (instanceId === LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID)
    {
        return {
            userId: scopeKey,
            "data.additionalData.paidDeckId": deckId,
            $or:
            [
                { "data.additionalData.paidDeckInstanceId": instanceId },
                { "data.additionalData.paidDeckInstanceId": { $exists: false } }
            ]
        };
    }
    return {
        userId: scopeKey,
        "data.additionalData.paidDeckId": deckId,
        "data.additionalData.paidDeckInstanceId": instanceId
    };
}

/**
 * PaidDeckGrantHelpers
 *
 * Shared acquisition logic for the two ways a user can come to own a paid
 * deck — a paid checkout (VerifyPurchase) and a free / fully-discounted
 * grant (InitiatePurchase when totalMinor === 0). Both must issue an ACTIVE
 * DeckLicense and seed the buyer's encrypted per-user content copy; keeping
 * the logic here means a zero-price deck is granted exactly like a paid one
 * (and therefore surfaces on the home page).
 */

// entityTypes is a numeric enum; PaidDeckContentFingerprint keys its content
// field lists by name, so this maps between them in one place.
const ENTITY_TYPE_NAME_BY_VALUE =
{
    [entityTypes.DECK]: "DECK",
    [entityTypes.CARD]: "CARD",
    [entityTypes.STUDY_MATERIAL]: "STUDY_MATERIAL",
    [entityTypes.MOCK_TEST]: "MOCK_TEST"
};

/**
 * The content version a paid-deck document currently publishes. Distinct from
 * keyVersion, which tracks the master ASSET KEY and moves on key rotation
 * rather than on a content upload.
 */
function resolveDeckContentVersion(paidDeckDocument)
{
    const contentVersion = Number(paidDeckDocument?.contentSummary?.contentVersion);
    return Number.isInteger(contentVersion) && contentVersion > 0 ? contentVersion : 1;
}

/**
 * Records which content version this copy was seeded from, both on the copy's
 * instance entry (copies update independently, so they can diverge) and on the
 * license as a whole (the fallback for single-copy and legacy licenses).
 */
function stampSeededContentVersion(license, instanceId, contentVersion)
{
    const additionalData = license.getAdditionalData() || {};
    const instances = Array.isArray(additionalData.instances) ? additionalData.instances : [];

    for (const instance of instances)
    {
        if (instance && instance.instanceId === instanceId)
        {
            instance.contentVersion = contentVersion;
        }
    }

    additionalData.instances = instances;
    license.setAdditionalData(additionalData);

    // The license-level value is the MINIMUM across copies, so "is anything I
    // own out of date?" stays answerable without walking the array.
    const seededVersions = instances
        .map(instance => Number(instance?.contentVersion))
        .filter(version => Number.isInteger(version) && version > 0);
    license.setDownloadedContentVersion(seededVersions.length > 0 ? Math.min(...seededVersions) : contentVersion);
}

/**
 * Seeds ONE copy (instance) of the paid deck into the buyer's normal sync
 * collections (plaintext at rest; /Sync encrypts content on pull) and records
 * that instance on the license. The same buyer can hold several copies of one
 * deck — each gets its own remapped id space (so progress is detached) but
 * shares the deck's single content key, so one password unlock covers them all.
 *
 * The server-wrapped content key is generated lazily ONCE per license (the
 * first copy); subsequent copies reuse it — regenerating it would orphan the
 * password-wrap and break unlock for the sibling copies. The password-wrap is
 * left empty — the first /PaidDecks/UnlockSession lazily fills it from the
 * buyer's password; for a buyer who already set one we copy the existing
 * passwordHash + passwordSalt so the unlock challenge has something to verify.
 *
 * Returns { success, reason? } so the caller can drop a failed grant instead
 * of reporting a stale success.
 */
async function seedProtectedContentForLicense(database, userId, deckId, license, instanceId = LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID, instanceLabel = "Copy 1")
{
    // Where this copy's rows live. Read from the license rather than assumed to
    // be the personal id, so an organization-scoped grant seeds into that
    // organization's view and stays out of the buyer's own library.
    const scopeKey = PaidDeckScopeResolver.resolveForLicense(license, userId);

    const paidDeckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId });

    if (!paidDeckDocument)
    {
        return { success: false, reason: ErrorCodes.PAID_DECK_NOT_FOUND };
    }

    const masterManifest = await KeyManagementService.getMasterManifest(deckId, paidDeckDocument.keyVersion);
    if (!masterManifest)
    {
        return { success: false, reason: ErrorCodes.MASTER_DECRYPT_FAILED };
    }

    const rootDeckId = (masterManifest && typeof masterManifest.rootDeckId === "string") ? masterManifest.rootDeckId : "";

    try
    {
        // Unified model: the buyer's paid deck is seeded as a NORMAL deck in the
        // regular sync collections (plaintext at rest — the server is the trusted
        // supplier), tagged additionalData.paidDeckId so the /Sync layer encrypts
        // its content fields on the wire. Normal sync then delivers it to every
        // device. No per-user encrypted store, no manifest.
        const collectionByEntityType =
        {
            [entityTypes.DECK]:           database.collection(DatabaseConstants.DECKS_COLLECTION),
            [entityTypes.CARD]:           database.collection(DatabaseConstants.CARDS_COLLECTION),
            [entityTypes.STUDY_MATERIAL]: database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION),
            [entityTypes.MOCK_TEST]:      database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION)
        };

        // Idempotent re-seed: drop any prior rows for THIS copy only — never
        // the sibling copies (the filter is instance-scoped).
        const priorRowsFilter = buildPaidInstanceRowFilter(scopeKey, deckId, instanceId);
        await Promise.all(Object.values(collectionByEntityType).map((collection) => collection.deleteMany(priorRowsFilter)));

        const seedTimestamp = new Date();
        const rowsByEntityType =
        {
            [entityTypes.DECK]:           [],
            [entityTypes.CARD]:           [],
            [entityTypes.STUDY_MATERIAL]: [],
            [entityTypes.MOCK_TEST]:      []
        };

        for await (const entityBatch of KeyManagementService.iterateMasterEntitiesDecrypted(deckId, paidDeckDocument.keyVersion))
        {
            for (const entity of entityBatch)
            {
                const targetBuffer = rowsByEntityType[entity.entityType];
                if (!targetBuffer)
                {
                    continue;
                }

                const entityData = (entity.plaintext && typeof entity.plaintext === "object") ? entity.plaintext : {};

                // Remap to a per-buyer, per-copy id so this copy never collides
                // with another deck the buyer owns NOR with their other copies of
                // the same deck. All three references thread the same instanceId.
                entityData.id = remapPaidEntityId(entity.entityId, scopeKey, deckId, instanceId);

                if (entity.entityType === entityTypes.DECK)
                {
                    // The bundle root attaches under the buyer's root deck so it
                    // shows as a top-level deck; sub-decks point at the remapped
                    // id of their (also-remapped) parent deck.
                    entityData.parent = (entity.entityId === rootDeckId)
                        ? USER_ROOT_DECK_ID
                        : remapPaidEntityId(entityData.parent, scopeKey, deckId, instanceId);
                }
                else
                {
                    // Card / study material / mock test: re-point deckId at the
                    // remapped id of its owning deck.
                    entityData.deckId = remapPaidEntityId(entityData.deckId, scopeKey, deckId, instanceId);
                }

                // Stamp the paid tag on every entity so the sync layer encrypts
                // its content and the client renders it as an owned paid deck.
                // The tag is the licensed BUNDLE id (paidDeckId) — never remapped.
                // paidDeckInstanceId scopes the row to this copy (so a per-copy
                // re-seed / delete never touches siblings); the root deck also
                // carries the human-facing copy label.
                const existingAdditionalData = (entityData.additionalData && typeof entityData.additionalData === "object") ? entityData.additionalData : {};
                entityData.additionalData = { ...existingAdditionalData, paidDeckId: deckId, paidDeckInstanceId: instanceId };

                // Fingerprint the SELLER's content as seeded. A later content
                // update compares this per entity to decide whether the buyer
                // keeps their study progress and their own edit for that entity
                // or has to start it over — without it, an update can only keep
                // everything (corrupting FSRS state) or reset everything (so a
                // one-typo fix costs a 2,000-card deck's whole history).
                const contentFingerprint = PaidDeckContentFingerprint.compute(entityData, ENTITY_TYPE_NAME_BY_VALUE[entity.entityType]);
                if (contentFingerprint)
                {
                    entityData.additionalData.paidContentFingerprint = contentFingerprint;
                }
                if (entity.entityType === entityTypes.DECK && entity.entityId === rootDeckId)
                {
                    entityData.additionalData.paidDeckInstanceLabel = instanceLabel;
                }

                targetBuffer.push({ userId: scopeKey, data: entityData, serverUpdatedAt: seedTimestamp });
            }
        }

        const insertPromises = [];
        for (const entityTypeKey of Object.keys(rowsByEntityType))
        {
            const rows = rowsByEntityType[entityTypeKey];
            if (rows.length > 0)
            {
                insertPromises.push(collectionByEntityType[entityTypeKey].insertMany(rows, { ordered: false }));
            }
        }
        await Promise.all(insertPromises);
    }
    catch (writeError)
    {
        console.error(`[PaidDeckGrant] Normalized seed failed for user ${userId} deck ${deckId}:`, writeError);
        return { success: false, reason: ErrorCodes.USER_CONTENT_WRITE_FAILED };
    }

    // Record this copy on the license registry and bump rotatedAt so the next
    // /Sync/Licenses pull re-delivers the updated instances array to the client.
    registerInstanceOnLicense(license, deckId, scopeKey, rootDeckId, instanceId, instanceLabel);
    stampSeededContentVersion(license, instanceId, resolveDeckContentVersion(paidDeckDocument));
    license.setRotatedAt(new Date());

    // The server-wrapped content key is per-LICENSE, not per-copy: generate it
    // only the first time (when the license has none yet). Additional copies
    // reuse it, so one password unlock decrypts every copy. Regenerating it
    // would orphan the password-wrap and break unlock for the sibling copies.
    let newContentKeyBytes = null;
    if (!license.getServerWrappedContentKeyBase64())
    {
        newContentKeyBytes = KeyManagementService.generatePaidDeckContentKey();
        try
        {
            const serverWrap = KeyManagementService.wrapPaidDeckContentKeyWithServerKek(newContentKeyBytes, deckId);
            license.setServerWrappedIvBase64(serverWrap.ivBase64);
            license.setServerWrappedContentKeyBase64(serverWrap.ciphertextBase64);
            license.setContentKeyVersion(1);

            // An organization's deck has no password and must never acquire
            // one: it is provided by the institute, unlocks automatically, and
            // copying the member's marketplace password here would leave a
            // licence that LOOKS password-protected while nothing ever asks for
            // that password — an unlock path that can only fail.
            const existingPasswordedLicense = PaidDeckAudienceResolver.isOrganizationDeck(paidDeckDocument)
                ? null
                : await database
                    .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
                    .findOne
                    ({
                        userId: userId,
                        deckId: { $ne: deckId },
                        status: deckLicenseStatuses.ACTIVE,
                        passwordHash: { $exists: true, $ne: "" }
                    });

            if (existingPasswordedLicense)
            {
                license.setPasswordHash(existingPasswordedLicense.passwordHash);
                license.setPasswordSalt(existingPasswordedLicense.passwordSalt);
                // passwordWrappedContentKey is intentionally left empty
                // (unlock's lazy-fill path picks it up using the same
                // password the buyer already set).
            }
        }
        finally
        {
            newContentKeyBytes.fill(0);
        }
    }

    try
    {
        await KeyManagementService.persistLicense(license);
    }
    catch (persistError)
    {
        return { success: false, reason: ErrorCodes.LICENSE_PERSIST_FAILED };
    }

    return { success: true };
}

async function checkUserHasPaidDeckPassword(database, userId)
{
    const existingDocumentWithPassword = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .findOne
        ({
            userId: userId,
            status: deckLicenseStatuses.ACTIVE,
            passwordHash: { $exists: true, $ne: "" }
        });
    return existingDocumentWithPassword !== null;
}

/**
 * Issues an ACTIVE license for (userId, deckId) and seeds the buyer's
 * encrypted per-user content copy. Returns the persisted license JSON on
 * success, or null on failure (caller decides how to surface it).
 */
async function grantAndSeedDeck(database, userId, deckId, licenseOptions)
{
    const licenseResult = await KeyManagementService.issueLicenseForDeck(userId, deckId, licenseOptions);
    if (!licenseResult.success)
    {
        return null;
    }

    const seedResult = await seedProtectedContentForLicense(database, userId, deckId, licenseResult.license);
    if (!seedResult.success)
    {
        console.error(`[PaidDeckGrant] Failed to seed content for user ${userId} deck ${deckId}: ${seedResult.reason}`);
        // issueLicenseForDeck already persisted an ACTIVE license; roll it back
        // so we don't leave a license with no seeded content (which would
        // surface a broken home tile that fails the moment it's opened).
        try
        {
            await KeyManagementService.revokeLicense(userId, deckId);
        }
        catch (revokeError)
        {
            console.error(`[PaidDeckGrant] Failed to roll back license for user ${userId} deck ${deckId}:`, revokeError);
        }
        return null;
    }

    return licenseResult.license.toJson();
}

module.exports = { seedProtectedContentForLicense, checkUserHasPaidDeckPassword, grantAndSeedDeck, removeInstanceFromLicense, buildPaidInstanceRowFilter, remapPaidEntityId, resolveDeckContentVersion, stampSeededContentVersion, ENTITY_TYPE_NAME_BY_VALUE };
