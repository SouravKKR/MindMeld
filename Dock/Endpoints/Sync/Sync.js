const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const PaidDeckSyncCrypto = require("../../Globals/Classes/Security/PaidDeckSyncCrypto");
const StorageCreditAssessor = require("../../Globals/Classes/Credits/StorageCreditAssessor");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");
const { deckLicenseStatuses } = require("../../Globals/Enumerations/DeckLicenseStatuses");

// ── Pull-phase chunking ────────────────────────────────────────────────
//
// A single MongoDB find().toArray() will happily load every matching
// document into memory, and `PacketronResponse.sendJson` then asks V8 to
// `JSON.stringify` the lot. Past ~hundreds of MB of stringified payload
// (e.g. ~5 000 cards each carrying rich answer HTML) the
// `IncrementalStringBuilder` inside V8 trips its internal string-length
// cap and aborts the Node process with FatalProcessOutOfMemory.
//
// We cap each pulled collection and signal `morePending: true` so the
// client immediately re-syncs and drains the remainder. We round the
// cut-point up to the next distinct `serverUpdatedAt` so a same-timestamp
// group (a single bulkUpsert chunk where every doc shares one writeDate)
// is never split — the next pull's `serverUpdatedAt > lastSync` cutoff
// would otherwise skip the tail of that group and silently drop data.
//
// DECKS get a much higher cap than the other entity types because the
// client's apply phase (SyncApplier.#applyDeckChangesInOrder) drops any
// deck whose parent isn't already in the local tree. If chunking splits
// the deck hierarchy across cycles, every deck in a chunk whose ancestor
// lives in a later chunk is silently dropped, and so are the cards that
// belong to it — even though the drain still completes cleanly and the
// client shows "Synced" with an empty home page. Pulling every deck in
// one cycle guarantees the full topology is in memory before any card,
// study-material or mock-test apply runs.
const MAX_PULL_DECKS              = 50000;
const MAX_PULL_PER_COLLECTION     = 200;
const FETCH_BUFFER_BEYOND_MAX     = 100;
const MAX_PULL_DELETIONS          = 2000;

async function handleSync(request, response)
{
    console.log("[Sync] /Sync endpoint hit.");

    const user = await getUser(request);

    if (!user)
    {
        console.warn("[Sync] Unauthorized — no user found in session.");
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const userId = user.getId();
    const deviceId = body.deviceId;
    const lastSync = body.lastSync || 0;
    const changes = body.changes || [];
    const isLastChunk = body.isLastChunk !== false; // default true for backward compat

    if (!deviceId)
    {
        response.sendStatusCode(400);
        return;
    }

    // Lazily bill the recurring storage categories (debounced to once per
    // 24h inside the assessor). Fire-and-forget so the sync round-trip is
    // never blocked on the footprint aggregation or the charge.
    StorageCreditAssessor.assess(user).catch(() => {});

    // ── Per-chunk lock-holder verification ────────────────────────────
    //
    // The client acquires the sync lock once via /Sync/Lock before the
    // multi-chunk push, but each chunk lands here as an independent
    // request. If the original holder's network stalls long enough for
    // its lock TTL to expire (or another device hits /Sync/ForceUnlock),
    // a second device can acquire the lock and start its own push —
    // and without this check the original device's remaining chunks
    // would still be accepted, interleaving two timelines into the same
    // serverUpdatedAt window and corrupting the per-entity history.
    //
    // 423 Locked tells the client "your lock is gone; re-acquire and
    // restart this sync cycle from the top." SyncOrchestrator's catch
    // path treats a non-2xx chunk response as a hard failure, resets
    // pendingChanges-removal (so the user's records aren't lost), and
    // the next debounced cycle re-races for the lock cleanly.
    const lockState = await TaskManager.getSyncLockState(userId);
    if (!lockState.bIsLocked || lockState.holderDeviceId !== deviceId)
    {
        console.warn(`[Sync] Rejecting push from device ${deviceId} — lock is ${lockState.bIsLocked ? "held by " + lockState.holderDeviceId : "not held"}.`);
        response.sendStatusCode(423);
        return;
    }

    // ===================== PUSH PHASE =====================
    console.log(`[Sync] PUSH PHASE — ${changes.length} changes, isLastChunk=${isLastChunk}`);

    const db = await DatabaseConnector.getDatabase();

    const byType =
    {
        [entityTypes.DECK]:               [],
        [entityTypes.CARD]:               [],
        [entityTypes.STUDY_MATERIAL]:     [],
        [entityTypes.MOCK_TEST]:          [],
        [entityTypes.ASK_AI_POPUP_LINK]:  [],
        deletions:                        []
    };

    for (const change of changes)
    {
        if (change.deleted)
        {
            byType.deletions.push(change);
            continue;
        }

        if (byType[change.entityType] !== undefined)
        {
            byType[change.entityType].push(change.data);
        }
        else
        {
            console.warn(`[Sync] Unknown entityType ${change.entityType}`);
        }
    }

    // Paid decks now ride the normal sync pipeline, but their CONTENT is
    // authored solely by the server (provisioning) and stored plaintext here.
    // A client push only carries progress / lifecycle / history — never valid
    // content (it holds ciphertext). Overlay the server's plaintext content
    // back onto every incoming paid entity so a push can't overwrite content,
    // keep the paidDeckId tag authoritative, and drop any client attempt to
    // author a brand-new paid entity. This is the server-side enforcement of
    // "content is read-only on the device".
    await preservePaidContentOnPush(db, userId, byType);

    // Single Node-clock timestamp for every doc written in this push.
    // Used both as `serverUpdatedAt` on the upserted docs and as the
    // floor for this response's `serverTime`, so the client's saved
    // `lastSync` is never earlier than any doc it has now stored —
    // even if Mongo's host clock is skewed ahead of Node's.
    const pushWriteTimestamp = new Date();

    // Upserts run concurrently across collections, but the deletion
    // cascade must wait until they have ALL settled. The cascade in
    // bulkRecordDeletions reads each entity collection's current state
    // by data.deckId / data.parent to discover descendants; if a card
    // or material was just re-parented by a concurrent upsert in this
    // same push (merge flow, drag-drop, etc.) the cascade would
    // otherwise see its pre-upsert deckId and pick it up as a victim of
    // the old parent's deletion. Sequencing upserts → deletions makes
    // the cascade observe the post-move state and leave the re-parented
    // entity alone.
    await Promise.all(
    [
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.DECKS_COLLECTION),             byType[entityTypes.DECK],              pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.CARDS_COLLECTION),             byType[entityTypes.CARD],              pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION),   byType[entityTypes.STUDY_MATERIAL],    pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.MOCK_TESTS_COLLECTION),        byType[entityTypes.MOCK_TEST],         pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION), byType[entityTypes.ASK_AI_POPUP_LINK], pushWriteTimestamp),
    ]);
    await SyncQueryEngine.bulkRecordDeletions(userId, db, byType.deletions);

    console.log(`[Sync] PUSH complete — decks:${byType[entityTypes.DECK].length} cards:${byType[entityTypes.CARD].length} studyMaterials:${byType[entityTypes.STUDY_MATERIAL].length} mockTests:${byType[entityTypes.MOCK_TEST].length} popupLinks:${byType[entityTypes.ASK_AI_POPUP_LINK].length} deletions:${byType.deletions.length}`);

    // Best-effort cleanup of the two legacy fields the client no
    // longer ships (studyMaterials embedded in the deck doc, and the
    // old additionalData.askAiPopupLinks map). The filter targets only
    // docs that still carry them — already-clean decks are a no-op.
    // Skipped when this push touched no decks because the cleanup is
    // tied to "this cycle modified some deck doc" semantics; a pure
    // card / popup push leaves deck docs untouched.
    if (byType[entityTypes.DECK].length > 0)
    {
        try
        {
            await SyncQueryEngine.pruneLegacyDeckFields(userId);
        }
        catch (pruneError)
        {
            // Don't fail the sync over a cleanup; the legacy fields
            // are just bloat, not correctness-affecting.
            console.warn(`[Sync] pruneLegacyDeckFields skipped: ${pruneError?.message || pruneError}`);
        }
    }

    // ===================== INTERMEDIATE CHUNK — skip pull =====================
    if (!isLastChunk)
    {
        response.sendJson({ ok: true });
        return;
    }

    // ── Full-resync push detection ──────────────────────────────────────
    //
    // Historically this branch skipped the pull whenever the client
    // arrived with `lastSync === 0 && changes.length > 0`, on the
    // assumption that any such cycle was a desktop wipe-recovery push
    // and the client already had everything locally. That assumption
    // breaks the OTHER `lastSync === 0` shape — a fresh-incognito
    // login whose only local entity is the just-created root deck.
    // The fresh client also pushes 1 change with lastSync = 0, the
    // skip then fires, the pull is suppressed, and the client's home
    // page stays empty even though the server has all their data.
    //
    // The original motivation (500 MB JSON.stringify OOM when the pull
    // echoed every just-pushed doc back) is now solved by the chunked
    // pull above. We always run the pull, the per-collection caps
    // bound the response, and a wipe-recovery push just spends an
    // extra round-trip echoing its own data back through an idempotent
    // apply — wasteful but correct, and far better than silently
    // hiding a returning user's library.
    const bIsFullResyncPush = false;

    let serverChanges                  = [];
    let serverDeletions                = [];
    let bMorePending                   = false;
    let highestReturnedTimestamp       = 0;
    const overflowWatermarks           = [];

    // Per-request cache of unwrapped paid-deck content keys (one per owned paid
    // deck), so the pull encrypts every entity of a deck without re-deriving the
    // key each time. A null entry means "no active license" — that deck's
    // entities are withheld from the pull entirely (access is ownership-bound).
    // All buffers are zeroed before the response is sent.
    const paidContentKeyByDeckId = new Map();
    const resolvePaidContentKey = async (paidDeckId) =>
    {
        if (paidContentKeyByDeckId.has(paidDeckId))
        {
            return paidContentKeyByDeckId.get(paidDeckId);
        }
        const contentKeyBuffer = await KeyManagementService.getPaidDeckContentKeyBufferForUser(userId, paidDeckId);
        paidContentKeyByDeckId.set(paidDeckId, contentKeyBuffer);
        return contentKeyBuffer;
    };

    if (bIsFullResyncPush)
    {
        console.log(`[Sync] PULL PHASE skipped — full-resync push (${changes.length} entities in this chunk; client already has all data locally).`);
    }
    else
    {
        // ===================== PULL PHASE =====================
        console.log("[Sync] PULL PHASE");

        // Tombstone-on-lapse (security req #6 + stale-orphan cleanup): tear down
        // the seeded rows of any paid deck whose license has lapsed BEFORE the
        // pull fetch + getDeletionsSince, so the resulting tombstones ride out in
        // this same response and the client drops its now-unlicensed copy.
        await tombstoneLapsedPaidDeckRows(db, userId);

        const pullConfig =
        [
            { collection: DatabaseConstants.DECKS_COLLECTION,             entityType: entityTypes.DECK,              name: "Deck",          maxPull: MAX_PULL_DECKS          },
            { collection: DatabaseConstants.CARDS_COLLECTION,             entityType: entityTypes.CARD,              name: "Card",          maxPull: MAX_PULL_PER_COLLECTION },
            { collection: DatabaseConstants.STUDY_MATERIALS_COLLECTION,   entityType: entityTypes.STUDY_MATERIAL,    name: "StudyMaterial", maxPull: MAX_PULL_PER_COLLECTION },
            { collection: DatabaseConstants.MOCK_TESTS_COLLECTION,        entityType: entityTypes.MOCK_TEST,         name: "MockTest",      maxPull: MAX_PULL_PER_COLLECTION },
            { collection: DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION, entityType: entityTypes.ASK_AI_POPUP_LINK, name: "PopupLink",     maxPull: MAX_PULL_PER_COLLECTION }
        ];

        const lastSyncDate = new Date(lastSync);

        const pullPromises = pullConfig.map((cfg) => db.collection(cfg.collection).find(
        {
            userId: userId,
            serverUpdatedAt: { $gt: lastSyncDate }
        })
        .sort({ serverUpdatedAt: 1 })
        .limit(cfg.maxPull + FETCH_BUFFER_BEYOND_MAX + 1)
        .toArray());

        const [documentsByPullConfig, pulledDeletions] = await Promise.all(
        [
            Promise.all(pullPromises),
            SyncQueryEngine.getDeletionsSince(userId, lastSync)
        ]);

        for (let pullConfigIndex = 0; pullConfigIndex < pullConfig.length; pullConfigIndex++)
        {
            const cfg = pullConfig[pullConfigIndex];
            let documents = documentsByPullConfig[pullConfigIndex];
            let bCollectionOverflowed = false;

            if (documents.length > cfg.maxPull)
            {
                bCollectionOverflowed = true;

                // Advance the cut-point past the MAX threshold until we
                // cross a distinct `serverUpdatedAt`, so a same-timestamp
                // bulkUpsert group is never split.
                let cutIndex = cfg.maxPull;
                const lastIncludedTimestamp = documents[cutIndex - 1].serverUpdatedAt.getTime();

                while (cutIndex < documents.length
                    && documents[cutIndex].serverUpdatedAt.getTime() === lastIncludedTimestamp)
                {
                    cutIndex++;
                }

                if (cutIndex === documents.length)
                {
                    // We ran past the fetched buffer while still inside a
                    // single same-timestamp group. Fetch the remainder of
                    // that group directly so the watermark is safe to
                    // advance past it.
                    const extraDocuments = await db.collection(cfg.collection).find(
                    {
                        userId:          userId,
                        serverUpdatedAt: new Date(lastIncludedTimestamp)
                    }).toArray();

                    const seenIds = new Set(documents.map((document) => document._id.toString()));
                    for (const extraDocument of extraDocuments)
                    {
                        if (!seenIds.has(extraDocument._id.toString()))
                        {
                            documents.push(extraDocument);
                            seenIds.add(extraDocument._id.toString());
                        }
                    }
                }
                else
                {
                    documents.length = cutIndex;
                }

                overflowWatermarks.push(lastIncludedTimestamp);
            }

            for (const document of documents)
            {
                let outgoingData = document.data;

                // Paid entity: encrypt its content fields before they leave the
                // server so the wire + client IndexedDB only ever hold
                // ciphertext. With no active license the entity is withheld.
                const paidDeckId = document.data?.additionalData?.paidDeckId;
                if (typeof paidDeckId === "string" && paidDeckId.length > 0)
                {
                    const contentKeyBuffer = await resolvePaidContentKey(paidDeckId);
                    if (!contentKeyBuffer)
                    {
                        continue;
                    }
                    outgoingData = PaidDeckSyncCrypto.encryptEntityContent(cfg.entityType, document.data, contentKeyBuffer);
                }

                serverChanges.push(
                {
                    entityId:   document.data.id,
                    entityType: cfg.entityType,
                    data:       outgoingData
                });

                const documentTimestamp = document.serverUpdatedAt.getTime();
                if (documentTimestamp > highestReturnedTimestamp)
                {
                    highestReturnedTimestamp = documentTimestamp;
                }
            }

            console.log(`[Sync] Pulled ${documents.length} ${cfg.name}(s)${bCollectionOverflowed ? " (chunked — more pending)" : ""}`);
        }

        if (pulledDeletions.length > MAX_PULL_DELETIONS)
        {
            const trimmedDeletions = pulledDeletions
                .slice()
                .sort((a, b) => a.deletedAt.getTime() - b.deletedAt.getTime())
                .slice(0, MAX_PULL_DELETIONS);
            const lastDeletionTimestamp = trimmedDeletions[trimmedDeletions.length - 1].deletedAt.getTime();
            serverDeletions = trimmedDeletions;
            overflowWatermarks.push(lastDeletionTimestamp);
            console.log(`[Sync] Pulled ${MAX_PULL_DELETIONS}/${pulledDeletions.length} deletion(s) (chunked — more pending)`);
        }
        else
        {
            serverDeletions = pulledDeletions;
        }

        for (const deletion of serverDeletions)
        {
            const deletionTimestamp = deletion.deletedAt.getTime();
            if (deletionTimestamp > highestReturnedTimestamp)
            {
                highestReturnedTimestamp = deletionTimestamp;
            }
        }

        bMorePending = overflowWatermarks.length > 0;

        // Zero every unwrapped content key the pull derived — plaintext key
        // bytes must not linger in process memory beyond the request.
        for (const contentKeyBuffer of paidContentKeyByDeckId.values())
        {
            if (contentKeyBuffer)
            {
                contentKeyBuffer.fill(0);
            }
        }
        paidContentKeyByDeckId.clear();
    }

    // When the pull is chunked, the cutoff for the *next* cycle is the
    // smallest overflow watermark — any larger value would skip past
    // unsynced docs in a collection whose watermark came in below.
    //
    // When the pull completed, the cutoff should advance to "now" so
    // future writes are picked up — but never below the highest
    // serverUpdatedAt we just returned. Otherwise a clock skew between
    // Node and Mongo (or between Node and the documents' write time)
    // would let the same docs match the next pull's `> lastSync`
    // cutoff and we'd re-pull them in an infinite loop.
    const nodeNow      = Date.now();
    const pushFloor    = pushWriteTimestamp.getTime();
    const returnedTail = highestReturnedTimestamp > 0 ? highestReturnedTimestamp + 1 : 0;
    const serverTime   = bMorePending
        ? Math.min(...overflowWatermarks)
        : Math.max(nodeNow, pushFloor, returnedTail);

    // When chunking, also report how many entities still wait beyond
    // this cycle's watermark so the client can render a true overall
    // percentage across the multi-cycle drain instead of restarting
    // its bar at 0 each chunk. Cheap relative to the pull itself —
    // four count_documents per response, all hitting the userId index.
    let remainingEntityCount = 0;
    if (bMorePending)
    {
        const nextCutoffDate = new Date(serverTime);
        const pullCollections =
        [
            DatabaseConstants.DECKS_COLLECTION,
            DatabaseConstants.CARDS_COLLECTION,
            DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            DatabaseConstants.MOCK_TESTS_COLLECTION
        ];

        const remainingCountPromises = pullCollections.map((collectionName) =>
            db.collection(collectionName).countDocuments(
            {
                userId:          userId,
                serverUpdatedAt: { $gt: nextCutoffDate }
            })
        );
        const remainingDeletionPromise = db.collection(DatabaseConstants.DELETIONS_COLLECTION).countDocuments(
        {
            userId:    userId,
            deletedAt: { $gt: nextCutoffDate }
        });

        const remainingCounts = await Promise.all([...remainingCountPromises, remainingDeletionPromise]);
        remainingEntityCount  = remainingCounts.reduce((sum, count) => sum + count, 0);
        console.log(`[Sync] Estimated ${remainingEntityCount} entities still pending beyond this chunk.`);
    }

    await SyncQueryEngine.upsertSyncData(userId, deviceId, serverTime);

    // ── Wipe-recovery detection ─────────────────────────────────────────
    //
    // After a server-side DB wipe, returning clients still hold their
    // pre-wipe local `lastSyncTimestamp` and will never push back any
    // entity older than that cutoff. Without an explicit signal, the
    // client never realises the server lost everything and the user's
    // decks stay stranded on disk.
    //
    // Detect the asymmetric state — server has zero docs for this user,
    // the client claims to be already synced, AND it pushed nothing this
    // cycle (so we're not catching a brand-new push mid-flight) — and
    // hint the client with `requestFullResync: true`. The client
    // (SyncOrchestrator) resets its local timestamp to 0 and re-runs the
    // cycle; its zero-timestamp branch then calls
    // SyncApplier.gatherAllLocalEntities() to push every local entity.
    //
    // The check fires AFTER the push phase, so a healthy client that
    // happens to have nothing to push on this cycle is NOT flagged (the
    // PUSH would have populated the server). It only flags the genuine
    // "server is empty, client thinks it isn't" asymmetry. Also skipped
    // during a full-resync push — we just absorbed everything, the
    // userHasAnyData check is moot.
    let bRequestFullResync = false;
    if (!bIsFullResyncPush && !bMorePending && lastSync > 0 && changes.length === 0)
    {
        const userHasAnyData = await SyncQueryEngine.userHasAnyData(userId, db);
        if (!userHasAnyData)
        {
            console.warn(`[Sync] Server has no data for user ${userId} but client claims lastSync=${lastSync}. Requesting full resync.`);
            bRequestFullResync = true;
        }
    }

    response.sendJson(
    {
        changes:   serverChanges,
        deletions: serverDeletions,
        serverTime,
        morePending:         bMorePending,
        remainingEntityCount,
        requestFullResync:   bRequestFullResync
    });
}

/**
 * True iff a raw deckLicenses document is currently usable — status ACTIVE and
 * either a FOREVER sentinel expiry (epoch-zero) or a future expiry. Mirrors
 * KeyManagementService.isLicenseActive but reads the stored doc directly (the
 * pull path has no DeckLicense model instance handy).
 */
function isPaidLicenseDocumentActive(licenseDocument)
{
    if (!licenseDocument || licenseDocument.status !== deckLicenseStatuses.ACTIVE)
    {
        return false;
    }
    const expiresAt = licenseDocument.expiresAt;
    if (!expiresAt)
    {
        return true;
    }
    const expiryTimestampMs = new Date(expiresAt).getTime();
    if (isNaN(expiryTimestampMs))
    {
        return true;
    }
    if (expiryTimestampMs <= 0)
    {
        return true; // FOREVER sentinel.
    }
    return expiryTimestampMs > Date.now();
}

/**
 * Tombstone-on-lapse: for each of the user's paid-deck licenses that EXISTS but
 * is no longer active (REVOKED, or a finite expiry now in the past), tears down
 * the deck's seeded rows still sitting in the server collections so the client
 * deletes its now-unlicensed copy instead of leaving it stranded on the home
 * page (security req #6 — access must not persist past expiry). Deliberately
 * scoped to existing-inactive licenses ONLY — never a merely-absent license,
 * which can be a deck still mid-provision. Idempotent: once a deck's rows are
 * gone, later pulls find none and do nothing.
 */
async function tombstoneLapsedPaidDeckRows(database, userId)
{
    const licenseDocuments = await database
        .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
        .find({ userId: userId })
        .toArray();

    const lapsedDeckIds = licenseDocuments
        .filter((licenseDocument) => !isPaidLicenseDocumentActive(licenseDocument))
        .map((licenseDocument) => licenseDocument.deckId)
        .filter((deckId) => typeof deckId === "string" && deckId.length > 0);

    if (lapsedDeckIds.length === 0)
    {
        return;
    }

    const lapsedDeckRows = await database
        .collection(DatabaseConstants.DECKS_COLLECTION)
        .find({ userId: userId, "data.additionalData.paidDeckId": { $in: lapsedDeckIds } }, { projection: { "data.id": 1, _id: 0 } })
        .toArray();

    const deletionChanges = lapsedDeckRows
        .filter((row) => row?.data?.id)
        .map((row) => ({ entityId: row.data.id, entityType: entityTypes.DECK }));

    if (deletionChanges.length > 0)
    {
        // bulkRecordDeletions cascades each instance root to its cards /
        // materials / mock tests / popups and both tombstones and deletes them.
        await SyncQueryEngine.bulkRecordDeletions(userId, database, deletionChanges);
        console.log(`[Sync] Tombstoned ${deletionChanges.length} lapsed paid-deck root(s) for user ${userId}.`);
    }
}

/**
 * Server-side enforcement that paid-deck CONTENT is read-only on the device.
 * For every incoming paid entity (a card / study material / mock test / deck
 * whose server-stored copy carries additionalData.paidDeckId), overlay the
 * server's authoritative plaintext content back onto the push so a client's
 * ciphertext (or tampered) content can never overwrite it; force the
 * paidDeckId tag to the server's value so it can't be stripped; and drop any
 * attempt by a client to author a brand-new paid entity (the server is the
 * sole author of paid content). Only progress / lifecycle / history survive
 * from a paid push.
 */
async function preservePaidContentOnPush(database, userId, byType)
{
    const protectedTypeCollections =
    [
        { entityType: entityTypes.DECK,            collectionName: DatabaseConstants.DECKS_COLLECTION            },
        { entityType: entityTypes.CARD,            collectionName: DatabaseConstants.CARDS_COLLECTION            },
        { entityType: entityTypes.STUDY_MATERIAL,  collectionName: DatabaseConstants.STUDY_MATERIALS_COLLECTION  },
        { entityType: entityTypes.MOCK_TEST,       collectionName: DatabaseConstants.MOCK_TESTS_COLLECTION       }
    ];

    let droppedAuthoredPaidCount = 0;

    for (const { entityType, collectionName } of protectedTypeCollections)
    {
        const incomingArray = byType[entityType];
        if (!incomingArray || incomingArray.length === 0)
        {
            continue;
        }

        const incomingIds = incomingArray.map((data) => data?.id).filter((id) => typeof id === "string" && id.length > 0);
        if (incomingIds.length === 0)
        {
            continue;
        }

        const existingDocuments = await database.collection(collectionName).find({ userId: userId, "data.id": { $in: incomingIds } }).toArray();
        const existingDataById = new Map();
        for (const existingDocument of existingDocuments)
        {
            if (existingDocument?.data?.id)
            {
                existingDataById.set(existingDocument.data.id, existingDocument.data);
            }
        }

        const keptArray = [];
        for (const incomingData of incomingArray)
        {
            const existingData = existingDataById.get(incomingData?.id);
            const existingIsPaid = typeof existingData?.additionalData?.paidDeckId === "string" && existingData.additionalData.paidDeckId.length > 0;
            const incomingClaimsPaid = typeof incomingData?.additionalData?.paidDeckId === "string" && incomingData.additionalData.paidDeckId.length > 0;

            if (existingIsPaid)
            {
                // Known paid entity: keep the server's plaintext content + tag.
                const restoredData = PaidDeckSyncCrypto.restorePlaintextContent(entityType, incomingData, existingData);
                if (!restoredData.additionalData || typeof restoredData.additionalData !== "object")
                {
                    restoredData.additionalData = {};
                }
                restoredData.additionalData.paidDeckId = existingData.additionalData.paidDeckId;
                keptArray.push(restoredData);
            }
            else if (incomingClaimsPaid)
            {
                // Client trying to author a paid entity the server doesn't have:
                // reject (only provisioning may create paid content).
                droppedAuthoredPaidCount++;
            }
            else
            {
                keptArray.push(incomingData);
            }
        }

        byType[entityType] = keptArray;
    }

    if (droppedAuthoredPaidCount > 0)
    {
        console.warn(`[Sync] Dropped ${droppedAuthoredPaidCount} client-authored paid entity push(es) — paid content is server-authored only.`);
    }
}

module.exports = { handleSync };