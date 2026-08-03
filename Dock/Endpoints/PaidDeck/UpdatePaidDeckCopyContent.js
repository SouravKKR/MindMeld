const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const PaidDeckContentFingerprint = require("../../Globals/Classes/PaidDeck/PaidDeckContentFingerprint");
const PaidDeckContentUpdatePlanner = require("../../Globals/Classes/PaidDeck/PaidDeckContentUpdatePlanner");
const LicenseConstants = require("../../Globals/Constants/LicenseConstants");
const DeckLicense = require("../../Globals/Model/DeckLicense");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {
    buildPaidInstanceRowFilter,
    remapPaidEntityId,
    resolveDeckContentVersion,
    stampSeededContentVersion,
    ENTITY_TYPE_NAME_BY_VALUE
} = require("./PaidDeckGrantHelpers");

/**
 * POST /PaidDecks/Copies/UpdateContent
 *
 * Body: { deckId, instanceId, dryRun? }
 *
 * Moves ONE of a buyer's copies onto the publisher's current content version.
 *
 * A copy is pinned to the version it was seeded from and is never updated
 * behind the buyer's back — the publisher can ship v2 while every existing copy
 * keeps working on v1 indefinitely. Only this endpoint moves a copy forward,
 * and only when the buyer asks.
 *
 * ── Why this is not a re-seed ─────────────────────────────────────────────
 *
 * seedProtectedContentForLicense deletes the copy's rows and re-inserts them
 * from the master, whose progress fields are zeroed at export. Running it here
 * would wipe the buyer's study history for every card, including the ones the
 * publisher never touched. Instead this diffs the two versions per entity and
 * upserts: buyer ids are deterministic, so the same master entity always maps
 * to the same row, and an upsert on that row keeps its progress.
 *
 *   unchanged fingerprint -> progress, history and the buyer's own edit kept
 *   changed fingerprint   -> progress reset, the edit dropped (both described
 *                            text the publisher has replaced)
 *   entity added          -> seeded fresh
 *   entity removed        -> tombstoned, cascading its overlays to every device
 *
 * `dryRun: true` runs the same plan and returns only the counts, so the confirm
 * dialog can tell the buyer exactly what they are about to lose.
 *
 * ── Expiry ────────────────────────────────────────────────────────────────
 *
 * The license is NOT reissued and its expiresAt is never extended: updating a
 * rented deck must not renew the rental, or a monthly renter could hold it
 * forever by pressing Update.
 */
async function updatePaidDeckCopyContent(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;
    const instanceId = typeof body?.instanceId === "string" && body.instanceId.length > 0
        ? body.instanceId
        : LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID;
    const bDryRun = body?.dryRun === true;

    if (typeof deckId !== "string" || deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DECK_ID });
        return;
    }

    const userId = session.getUserId();
    const database = await DatabaseConnector.getDatabase();

    const licenseDocument = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .findOne({ userId: userId, deckId: deckId });

    const license = licenseDocument ? DeckLicense.fromJson(licenseDocument) : null;
    if (!license || !KeyManagementService.isLicenseActive(license))
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.LICENSE_NOT_FOUND });
        return;
    }

    const paidDeckDocument = await database
        .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
        .findOne({ id: deckId });

    if (!paidDeckDocument)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PAID_DECK_NOT_FOUND });
        return;
    }

    const collectionByEntityType =
    {
        [entityTypes.DECK]:           database.collection(DatabaseConstants.DECKS_COLLECTION),
        [entityTypes.CARD]:           database.collection(DatabaseConstants.CARDS_COLLECTION),
        [entityTypes.STUDY_MATERIAL]: database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION),
        [entityTypes.MOCK_TEST]:      database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION)
    };

    // ── Read the buyer's current rows for this copy ────────────────────────
    const instanceRowFilter = buildPaidInstanceRowFilter(userId, deckId, instanceId);
    const existingRowsById = new Map();

    for (const entityTypeKey of Object.keys(collectionByEntityType))
    {
        const storedRows = await collectionByEntityType[entityTypeKey]
            .find(instanceRowFilter, { projection: { _id: 0, data: 1 } })
            .toArray();

        for (const storedRow of storedRows)
        {
            if (storedRow?.data?.id)
            {
                existingRowsById.set(storedRow.data.id, {
                    id: storedRow.data.id,
                    fingerprint: storedRow.data.additionalData?.paidContentFingerprint || "",
                    entityType: Number(entityTypeKey),
                    data: storedRow.data
                });
            }
        }
    }

    // ── Read the new version's entities ────────────────────────────────────
    const masterManifest = await KeyManagementService.getMasterManifest(deckId, paidDeckDocument.keyVersion);
    if (!masterManifest)
    {
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.MASTER_DECRYPT_FAILED });
        return;
    }

    const rootDeckId = typeof masterManifest.rootDeckId === "string" ? masterManifest.rootDeckId : "";
    const incomingEntities = [];

    try
    {
        for await (const entityBatch of KeyManagementService.iterateMasterEntitiesDecrypted(deckId, paidDeckDocument.keyVersion))
        {
            for (const entity of entityBatch)
            {
                if (!collectionByEntityType[entity.entityType])
                {
                    continue;
                }

                const entityData = (entity.plaintext && typeof entity.plaintext === "object") ? entity.plaintext : {};
                incomingEntities.push
                ({
                    id: remapPaidEntityId(entity.entityId, userId, deckId, instanceId),
                    masterEntityId: entity.entityId,
                    entityType: entity.entityType,
                    fingerprint: PaidDeckContentFingerprint.compute(entityData, ENTITY_TYPE_NAME_BY_VALUE[entity.entityType]),
                    data: entityData
                });
            }
        }
    }
    catch (masterReadError)
    {
        console.error(`[UpdatePaidDeckCopyContent] Could not read the master for deck ${deckId}:`, masterReadError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.MASTER_DECRYPT_FAILED });
        return;
    }

    const updatePlan = PaidDeckContentUpdatePlanner.plan(Array.from(existingRowsById.values()), incomingEntities);
    const targetContentVersion = resolveDeckContentVersion(paidDeckDocument);

    if (bDryRun)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, dryRun: true, counts: updatePlan.counts, contentVersion: targetContentVersion });
        return;
    }

    // ── Apply ──────────────────────────────────────────────────────────────
    const writeTimestamp = new Date();
    const bulkOperationsByEntityType = {};

    const queueUpsert = (entityType, entityData) =>
    {
        if (!bulkOperationsByEntityType[entityType])
        {
            bulkOperationsByEntityType[entityType] = [];
        }
        bulkOperationsByEntityType[entityType].push
        ({
            updateOne:
            {
                filter: { userId: userId, "data.id": entityData.id },
                update: { $set: { userId: userId, data: entityData, serverUpdatedAt: writeTimestamp } },
                upsert: true
            }
        });
    };

    const buildSeededEntityData = (incomingEntity, bCarryProgressFrom) =>
    {
        const entityData = JSON.parse(JSON.stringify(incomingEntity.data));
        entityData.id = incomingEntity.id;

        if (incomingEntity.entityType === entityTypes.DECK)
        {
            entityData.parent = (incomingEntity.masterEntityId === rootDeckId)
                ? "0"
                : remapPaidEntityId(entityData.parent, userId, deckId, instanceId);
        }
        else
        {
            entityData.deckId = remapPaidEntityId(entityData.deckId, userId, deckId, instanceId);
        }

        const existingAdditionalData = (entityData.additionalData && typeof entityData.additionalData === "object") ? entityData.additionalData : {};
        entityData.additionalData = { ...existingAdditionalData, paidDeckId: deckId, paidDeckInstanceId: instanceId };

        const contentFingerprint = PaidDeckContentFingerprint.compute(entityData, ENTITY_TYPE_NAME_BY_VALUE[incomingEntity.entityType]);
        if (contentFingerprint)
        {
            entityData.additionalData.paidContentFingerprint = contentFingerprint;
        }

        // Carry the buyer's own study state across for an entity whose content
        // did not change. The master's copies of these fields are zeroed at
        // export, so without this every update would silently reset the deck.
        if (bCarryProgressFrom)
        {
            if (bCarryProgressFrom.progress !== undefined)  { entityData.progress = bCarryProgressFrom.progress; }
            if (bCarryProgressFrom.lifecycle !== undefined) { entityData.lifecycle = bCarryProgressFrom.lifecycle; }
            if (bCarryProgressFrom.history !== undefined)   { entityData.history = bCarryProgressFrom.history; }
            // The copy label lives on the root deck and is the buyer's, not the
            // publisher's.
            if (bCarryProgressFrom.additionalData?.paidDeckInstanceLabel)
            {
                entityData.additionalData.paidDeckInstanceLabel = bCarryProgressFrom.additionalData.paidDeckInstanceLabel;
            }
        }
        else if (incomingEntity.entityType === entityTypes.DECK && incomingEntity.masterEntityId === rootDeckId)
        {
            const existingRootRow = existingRowsById.get(incomingEntity.id);
            if (existingRootRow?.data?.additionalData?.paidDeckInstanceLabel)
            {
                entityData.additionalData.paidDeckInstanceLabel = existingRootRow.data.additionalData.paidDeckInstanceLabel;
            }
        }

        return entityData;
    };

    for (const carriedEntry of updatePlan.carried)
    {
        queueUpsert(carriedEntry.incomingEntity.entityType, buildSeededEntityData(carriedEntry.incomingEntity, carriedEntry.existingRow.data));
    }

    for (const resetEntry of updatePlan.reset)
    {
        // Fresh progress: the master's own zeroed fields are exactly right here.
        queueUpsert(resetEntry.incomingEntity.entityType, buildSeededEntityData(resetEntry.incomingEntity, null));
    }

    for (const addedEntity of updatePlan.added)
    {
        queueUpsert(addedEntity.entityType, buildSeededEntityData(addedEntity, null));
    }

    try
    {
        for (const entityTypeKey of Object.keys(bulkOperationsByEntityType))
        {
            const operations = bulkOperationsByEntityType[entityTypeKey];
            if (operations.length > 0)
            {
                await collectionByEntityType[entityTypeKey].bulkWrite(operations, { ordered: false });
            }
        }

        // Entities the publisher removed. Going through bulkRecordDeletions
        // rather than a raw deleteMany is what tombstones them for every other
        // device AND cascades their content overlays.
        if (updatePlan.removed.length > 0)
        {
            await SyncQueryEngine.bulkRecordDeletions(userId, database, updatePlan.removed.map(removedRow => (
            {
                entityId: removedRow.id,
                entityType: removedRow.entityType
            })));
        }

        // Drop the buyer's own edits to entities whose content changed — they
        // were written against text that no longer exists.
        const resetEntityIds = updatePlan.reset.map(resetEntry => resetEntry.existingRow.id);
        if (resetEntityIds.length > 0)
        {
            const staleOverlays = await database
                .collection(DatabaseConstants.CONTENT_OVERLAYS_COLLECTION)
                .find({ userId: userId, "data.targetEntityId": { $in: resetEntityIds } }, { projection: { _id: 0, "data.id": 1 } })
                .toArray();

            if (staleOverlays.length > 0)
            {
                await SyncQueryEngine.bulkRecordDeletions(userId, database, staleOverlays.map(overlayRow => (
                {
                    entityId: overlayRow.data.id,
                    entityType: entityTypes.CONTENT_OVERLAY
                })));
            }
        }
    }
    catch (writeError)
    {
        console.error(`[UpdatePaidDeckCopyContent] Update failed for user ${userId} deck ${deckId} copy ${instanceId}:`, writeError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.USER_CONTENT_WRITE_FAILED });
        return;
    }

    // Record the version this copy now holds. expiresAt is deliberately
    // untouched — an update is not a renewal.
    stampSeededContentVersion(license, instanceId, targetContentVersion);
    license.setRotatedAt(new Date());

    try
    {
        await KeyManagementService.persistLicense(license);
    }
    catch (persistError)
    {
        console.error(`[UpdatePaidDeckCopyContent] Could not persist the license for user ${userId} deck ${deckId}:`, persistError);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.LICENSE_PERSIST_FAILED });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, counts: updatePlan.counts, contentVersion: targetContentVersion });
}

module.exports = { updatePaidDeckCopyContent };
