const crypto = require("crypto");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const LicenseClientView = require("../../Globals/Classes/Security/LicenseClientView");
const { seedProtectedContentForLicense, buildPaidInstanceRowFilter } = require("./PaidDeckGrantHelpers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /PaidDecks/Copies/Add
 *
 * Adds another independent COPY of an already-owned paid deck to the buyer's
 * home page. Each copy is a full re-seed of the deck's content into the normal
 * sync collections with its own remapped id space, so progress / scheduling /
 * FSRS / Glicko / auto-analysis are detached per copy while the content stays
 * identical (and immutable, server-supplied). All copies share the deck's one
 * license + content key, so a single password unlock covers every copy.
 *
 * Body : { deckId }
 * Reply: { success, instance: { instanceId, rootDeckId, label, createdAt }, license }
 *
 * The new copy's seeded rows arrive on the client through the regular /Sync
 * pull (NOT /Sync/Licenses) — the client triggers a sync after this call.
 */
const PAID_ENTITY_COLLECTIONS =
[
    DatabaseConstants.DECKS_COLLECTION,
    DatabaseConstants.CARDS_COLLECTION,
    DatabaseConstants.STUDY_MATERIALS_COLLECTION,
    DatabaseConstants.MOCK_TESTS_COLLECTION
];

async function countUserPaidEntities(database, userId)
{
    const counts = await Promise.all(PAID_ENTITY_COLLECTIONS.map((collectionName) =>
        database
            .collection(collectionName)
            .countDocuments({ userId: userId, "data.additionalData.paidDeckId": { $exists: true } })
    ));
    return counts.reduce((runningTotal, count) => runningTotal + count, 0);
}

async function addPaidDeckCopy(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const userId = session.getUserId();
    const license = await KeyManagementService.getLicense(userId, deckId);

    // Adding a copy requires an active license — this enforces "can't copy a
    // deck you don't own" (#4) and "no access past expiry" (#6).
    if (!KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: "NO_ACTIVE_LICENSE" });
        return;
    }

    // A license with no instances array predates multi-copy support — it still
    // represents one (implicit) copy, so it counts as 1 toward the cap.
    const additionalData = (license.getAdditionalData() && typeof license.getAdditionalData() === "object")
        ? license.getAdditionalData()
        : {};
    const existingInstances = Array.isArray(additionalData.instances) ? additionalData.instances : [];
    const currentCopyCount = existingInstances.length > 0 ? existingInstances.length : 1;

    if (currentCopyCount >= LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: "COPY_LIMIT_REACHED", maxCopies: LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER });
        return;
    }

    const database = await DatabaseConnector.getDatabase();

    // Per-user data cap (#15): the 4-copy cap is the primary bound; this is the
    // backstop against a single buyer hoarding very large bundles across copies.
    const existingPaidEntityCount = await countUserPaidEntities(database, userId);
    if (existingPaidEntityCount >= LicenseConstants.MAX_PAID_DECK_ENTITIES_PER_USER)
    {
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({ error: "DATA_CAP_EXCEEDED" });
        return;
    }

    const instanceId = crypto.randomUUID();
    const instanceLabel = `Copy ${currentCopyCount + 1}`;

    const seedResult = await seedProtectedContentForLicense(database, userId, deckId, license, instanceId, instanceLabel);

    if (!seedResult.success)
    {
        // Best-effort cleanup of any rows the failed seed partially inserted so
        // a retry starts from a clean slate.
        try
        {
            const partialRowsFilter = buildPaidInstanceRowFilter(userId, deckId, instanceId);
            await Promise.all(PAID_ENTITY_COLLECTIONS.map((collectionName) =>
                database.collection(collectionName).deleteMany(partialRowsFilter)));
        }
        catch (cleanupError)
        {
            console.error(`[AddPaidDeckCopy] Cleanup after failed seed for user ${userId} deck ${deckId} copy ${instanceId}:`, cleanupError);
        }

        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "COPY_SEED_FAILED", reason: seedResult.reason });
        return;
    }

    // seedProtectedContentForLicense already registered the instance on the
    // license and persisted it (rotatedAt bumped), so the in-memory license is
    // authoritative — sanitize it straight back to the client.
    const sanitizedLicense = LicenseClientView.sanitize(license.toJson());
    const newInstance = (sanitizedLicense.additionalData?.instances || [])
        .find((instance) => instance.instanceId === instanceId) || null;

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, instance: newInstance, license: sanitizedLicense });
}

module.exports = { addPaidDeckCopy };
