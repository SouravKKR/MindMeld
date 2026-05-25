const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const { getUser } = require("../Helpers/GetUser");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const { entityTypes } = require("../../Globals/Enumerations/EntityTypes");

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

    // ===================== PUSH PHASE =====================
    console.log(`[Sync] PUSH PHASE — ${changes.length} changes, isLastChunk=${isLastChunk}`);

    const db = await DatabaseConnector.getDatabase();

    const byType =
    {
        [entityTypes.DECK]:           [],
        [entityTypes.CARD]:           [],
        [entityTypes.STUDY_MATERIAL]: [],
        [entityTypes.MOCK_TEST]:      [],
        deletions:                    []
    };

    for (const change of changes)
    {
        if (change.deleted)
        {
            byType.deletions.push(change);
        }
        else if (byType[change.entityType] !== undefined)
        {
            byType[change.entityType].push(change.data);
        }
        else
        {
            console.warn(`[Sync] Unknown entityType ${change.entityType}`);
        }
    }

    // Single Node-clock timestamp for every doc written in this push.
    // Used both as `serverUpdatedAt` on the upserted docs and as the
    // floor for this response's `serverTime`, so the client's saved
    // `lastSync` is never earlier than any doc it has now stored —
    // even if Mongo's host clock is skewed ahead of Node's.
    const pushWriteTimestamp = new Date();

    await Promise.all(
    [
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.DECKS_COLLECTION),           byType[entityTypes.DECK],           pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.CARDS_COLLECTION),           byType[entityTypes.CARD],           pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION), byType[entityTypes.STUDY_MATERIAL], pushWriteTimestamp),
        SyncQueryEngine.bulkUpsert(userId, db.collection(DatabaseConstants.MOCK_TESTS_COLLECTION),      byType[entityTypes.MOCK_TEST],      pushWriteTimestamp),
        SyncQueryEngine.bulkRecordDeletions(userId, db, byType.deletions)
    ]);

    console.log(`[Sync] PUSH complete — decks:${byType[entityTypes.DECK].length} cards:${byType[entityTypes.CARD].length} studyMaterials:${byType[entityTypes.STUDY_MATERIAL].length} mockTests:${byType[entityTypes.MOCK_TEST].length} deletions:${byType.deletions.length}`);

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

    if (bIsFullResyncPush)
    {
        console.log(`[Sync] PULL PHASE skipped — full-resync push (${changes.length} entities in this chunk; client already has all data locally).`);
    }
    else
    {
        // ===================== PULL PHASE =====================
        console.log("[Sync] PULL PHASE");

        const pullConfig =
        [
            { collection: DatabaseConstants.DECKS_COLLECTION,           entityType: entityTypes.DECK,           name: "Deck",          maxPull: MAX_PULL_DECKS          },
            { collection: DatabaseConstants.CARDS_COLLECTION,           entityType: entityTypes.CARD,           name: "Card",          maxPull: MAX_PULL_PER_COLLECTION },
            { collection: DatabaseConstants.STUDY_MATERIALS_COLLECTION, entityType: entityTypes.STUDY_MATERIAL, name: "StudyMaterial", maxPull: MAX_PULL_PER_COLLECTION },
            { collection: DatabaseConstants.MOCK_TESTS_COLLECTION,      entityType: entityTypes.MOCK_TEST,      name: "MockTest",      maxPull: MAX_PULL_PER_COLLECTION }
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
                serverChanges.push(
                {
                    entityId:   document.data.id,
                    entityType: cfg.entityType,
                    data:       document.data
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

module.exports = { handleSync };