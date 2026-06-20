import { serialize, deserialize } from "../../../ThirdParty/Bson/bson.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";
import { entityTypes } from "../../Enumerations/EntityTypes.js";
import { getRandomUuid } from "../../UtilityFunctions/GetRandomUuid.js";
import { fetchPostJsonWithTimeout, fetchGetJsonWithTimeout } from "../../UtilityFunctions/FetchWithTimeout.js";
import IndexedDbHelper from "../IndexedDbHelper.js";
import Persistence from "../Persistence.js";


/**
 * SyncTransport
 *
 * Single source of truth for everything that travels over the wire or
 * lives in long-term sync storage: the per-device UUID, the
 * lastSyncTimestamp, the pendingChanges queue, and the chunked push.
 *
 * No business logic — just I/O. SyncOrchestrator drives it.
 */
class SyncTransport
{
    static #SYNC_LOG_PATH                = "Sync/SyncLog.mmsd";
    static #DEVICE_ID_KEY                = "deviceId";
    static #NETWORK_TIMEOUT_MILLISECONDS = 120 * 1000;
    static #CHUNK_SIZE                   = 100;
    static #PARALLEL_CHUNK_LIMIT         = 5;

    static #SYNC_ENDPOINT_PATH   = "/Sync";
    static #SYNC_LOCK_PATH         = "/Sync/Lock";
    static #SYNC_UNLOCK_PATH       = "/Sync/Unlock";
    static #SYNC_FORCE_UNLOCK_PATH = "/Sync/ForceUnlock";
    static #SYNC_BULK_SNAPSHOT_PATH = "/Sync/BulkSnapshot";
    static #BULK_SNAPSHOT_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
    static #BULK_SNAPSHOT_PROGRESS_BATCH_SIZE  = 25;

    static #deviceId          = null;
    static #lastSyncTimestamp = 0;
    static #pendingChanges    = {};
    // One-shot "reset lastSync to 0 inside the next sync cycle, after
    // it has acquired the mutex" flag. Used by forcePullFromServer so
    // an in-flight sync that's about to overwrite lastSync with its own
    // serverTime can't race the user's reset to zero.
    static #bResetLastSyncRequested = false;

    // ── Device ID ─────────────────────────────────────────────────────

    static async loadOrGenerateDeviceId()
    {
        const storedDeviceId = await IndexedDbHelper.getValue(SyncTransport.#DEVICE_ID_KEY);

        if (storedDeviceId)
        {
            SyncTransport.#deviceId = storedDeviceId;
        }
        else
        {
            SyncTransport.#deviceId = getRandomUuid();
            await IndexedDbHelper.setValue(SyncTransport.#DEVICE_ID_KEY, SyncTransport.#deviceId);
        }
    }

    static getDeviceId()
    {
        return SyncTransport.#deviceId;
    }

    // ── Sync log ──────────────────────────────────────────────────────

    static async loadSyncLog()
    {
        const bExists = await Persistence.exists(SyncTransport.#SYNC_LOG_PATH);

        if (!bExists)
        {
            SyncTransport.#lastSyncTimestamp = 0;
            SyncTransport.#pendingChanges    = {};
            return;
        }

        try
        {
            const syncLogBson = await Persistence.read(SyncTransport.#SYNC_LOG_PATH, dataFormats.BUFFER);
            const syncLogJson = deserialize(syncLogBson);

            SyncTransport.#lastSyncTimestamp = syncLogJson.lastSyncTimestamp || 0;
            SyncTransport.#pendingChanges    = syncLogJson.pendingChanges    || {};
        }
        catch (loadError)
        {
            console.error("[SyncTransport] Failed to load sync log. Resetting.", loadError);
            SyncTransport.#lastSyncTimestamp = 0;
            SyncTransport.#pendingChanges    = {};
        }
    }

    static async saveSyncLog()
    {
        const syncLogJson =
        {
            lastSyncTimestamp: SyncTransport.#lastSyncTimestamp,
            pendingChanges:    SyncTransport.#pendingChanges,
        };

        const syncLogBson = serialize(syncLogJson);
        await Persistence.write(SyncTransport.#SYNC_LOG_PATH, syncLogBson, dataFormats.BUFFER);
    }

    // ── lastSyncTimestamp ─────────────────────────────────────────────

    static getLastSyncTimestamp()
    {
        return SyncTransport.#lastSyncTimestamp;
    }

    static setLastSyncTimestamp(timestamp)
    {
        SyncTransport.#lastSyncTimestamp = timestamp;
    }

    /**
     * Queue a request to reset `lastSyncTimestamp` to 0 at the start of
     * the NEXT sync cycle that acquires the mutex. Lets `forcePullFromServer`
     * be safe against an in-flight sync that's about to write its own
     * serverTime — the racing sync's write happens, then the next cycle
     * consumes the request and starts from epoch.
     */
    static requestLastSyncReset()
    {
        SyncTransport.#bResetLastSyncRequested = true;
    }

    /**
     * Consumed at the top of each sync cycle. Returns true (and clears
     * the flag + writes lastSync=0) iff a reset was queued. Idempotent.
     */
    static consumeLastSyncResetRequest()
    {
        if (!SyncTransport.#bResetLastSyncRequested)
        {
            return false;
        }
        SyncTransport.#bResetLastSyncRequested = false;
        SyncTransport.#lastSyncTimestamp       = 0;
        return true;
    }

    // ── pendingChanges ────────────────────────────────────────────────

    static getPendingChanges()
    {
        return SyncTransport.#pendingChanges;
    }

    static setPendingChange(entityId, changeRecord)
    {
        SyncTransport.#pendingChanges[entityId] = changeRecord;
    }

    static clearPendingChanges()
    {
        SyncTransport.#pendingChanges = {};
    }

    /**
     * Value-aware counterpart to `clearPendingChanges`. Used at the end of
     * a successful push: remove the entries that were actually sent, but
     * preserve any entry that a NEWER change has superseded since the push
     * snapshot was taken (so the next cycle ships the user's latest intent).
     *
     * This compares by VALUE (deleted flag + lifecycle.lastModified), not by
     * object reference. Reference identity was too fragile — any path that
     * replaced a pending record with an equal-content but different-reference
     * object during the cycle (a BSON sync-log round-trip, an ENTITY_CHANGED
     * re-queue from a user tap, or the apply-phase orphan tombstone re-queue
     * in SyncApplier) defeated the `===` check, leaving the record behind to
     * be re-pushed forever and feeding the runaway re-push loop.
     *
     * Per id, a record is REMOVED (it was successfully pushed and nothing
     * newer replaced it) when:
     *   - both the current and pushed records are deletion tombstones, or
     *   - both are upserts and the current one is NOT strictly newer than
     *     what was pushed (currentLastModified <= pushedLastModified).
     * It is KEPT (re-pushed next FRESH cycle) when a genuinely newer change
     * landed mid-push: a delete superseding the pushed upsert, an upsert
     * superseding a pushed delete (recreate-after-delete), or a strictly
     * newer upsert.
     */
    static removePushedChanges(pushedChanges)
    {
        for (let pushedChangeIndex = 0; pushedChangeIndex < pushedChanges.length; pushedChangeIndex++)
        {
            const pushedChange = pushedChanges[pushedChangeIndex];
            if (!pushedChange)
            {
                continue;
            }

            const currentRecord = SyncTransport.#pendingChanges[pushedChange.entityId];
            if (currentRecord === undefined)
            {
                continue;
            }

            const currentIsDeletion = currentRecord.deleted === true;
            const pushedIsDeletion  = pushedChange.deleted === true;

            let bWasSuperseded;
            if (currentIsDeletion || pushedIsDeletion)
            {
                // Tombstones carry no lifecycle. Only matching intent
                // (delete pushed, delete still queued) means it was sent;
                // a mismatch means a delete/recreate raced the push.
                bWasSuperseded = currentIsDeletion && pushedIsDeletion;
            }
            else
            {
                const currentLastModified = SyncTransport.#extractLastModifiedMillis(currentRecord);
                const pushedLastModified  = SyncTransport.#extractLastModifiedMillis(pushedChange);
                bWasSuperseded = currentLastModified <= pushedLastModified;
            }

            if (bWasSuperseded)
            {
                delete SyncTransport.#pendingChanges[pushedChange.entityId];
            }
        }
    }

    /**
     * Reads `data.lifecycle.lastModified` from a pending upsert record as
     * epoch milliseconds, defaulting to 0 when the field is missing or
     * unparseable. Used by removePushedChanges to decide whether a queued
     * record is newer than the one that was pushed.
     */
    static #extractLastModifiedMillis(changeRecord)
    {
        const lastModified = changeRecord?.data?.lifecycle?.lastModified;
        if (!lastModified)
        {
            return 0;
        }

        const parsedMillis = new Date(lastModified).getTime();
        return Number.isNaN(parsedMillis) ? 0 : parsedMillis;
    }

    static getPendingChangeCount()
    {
        return Object.keys(SyncTransport.#pendingChanges).length;
    }

    // ── Lock / Unlock ─────────────────────────────────────────────────

    static async acquireLock()
    {
        return await fetchPostJsonWithTimeout(
            SyncTransport.#SYNC_LOCK_PATH,
            { deviceId: SyncTransport.#deviceId },
            SyncTransport.#NETWORK_TIMEOUT_MILLISECONDS,
        );
    }

    static async releaseLock()
    {
        return await fetchPostJsonWithTimeout(
            SyncTransport.#SYNC_UNLOCK_PATH,
            { deviceId: SyncTransport.#deviceId },
            SyncTransport.#NETWORK_TIMEOUT_MILLISECONDS,
        );
    }

    /**
     * Force-releases the server-side sync lock for the authenticated
     * user regardless of which device holds it. The user-facing "Force"
     * button calls this when a previous cycle's lock leaked (crashed
     * tab, killed Node before TTL expiry, etc.) and the current device
     * is blocked from syncing on its own account.
     */
    static async forceReleaseLock()
    {
        return await fetchPostJsonWithTimeout(
            SyncTransport.#SYNC_FORCE_UNLOCK_PATH,
            {},
            SyncTransport.#NETWORK_TIMEOUT_MILLISECONDS,
        );
    }

    /**
     * Streams every entity the authenticated user owns from the
     * /Sync/BulkSnapshot NDJSON endpoint, parsing one line at a time
     * so the renderer never holds the entire response as a single
     * string — `response.json()` on a medium-large library blows the
     * V8 ~512 MB string cap and crashes the Chrome tab.
     *
     * Returns
     *   { decks, cards, studyMaterials, mockTests, popupLinks, serverTime, totalCount }
     * or `null` on transport failure.
     *
     * `onProgress(processedCount, totalCount)` is invoked when the
     * NDJSON header arrives (with processedCount = 0 and the real
     * totalCount) and again every #BULK_SNAPSHOT_PROGRESS_BATCH_SIZE
     * entities thereafter. The orchestrator wires this into
     * SyncEvents.ENTITY_PROGRESS so the UI can show "X / Y entities"
     * counts instead of an opaque percentage.
     */
    static async fetchBulkSnapshot(onProgress = null)
    {
        const abortController = new AbortController();
        const timeoutId       = setTimeout(() => abortController.abort(), SyncTransport.#BULK_SNAPSHOT_TIMEOUT_MILLISECONDS);

        try
        {
            const response = await fetch(SyncTransport.#SYNC_BULK_SNAPSHOT_PATH,
            {
                method: "GET",
                signal: abortController.signal,
            });

            if (!response.ok)
            {
                clearTimeout(timeoutId);
                console.error(`[SyncTransport] /Sync/BulkSnapshot returned status ${response.status}`);
                return null;
            }

            if (!response.body || typeof response.body.getReader !== "function")
            {
                clearTimeout(timeoutId);
                console.error("[SyncTransport] /Sync/BulkSnapshot — response.body is not a ReadableStream; cannot stream-parse.");
                return null;
            }

            const decks          = [];
            const cards          = [];
            const studyMaterials = [];
            const mockTests      = [];
            const popupLinks     = [];
            let serverTime       = Date.now();
            let totalCount       = 0;
            let processedCount   = 0;

            const handleLine = (rawLine) =>
            {
                const line = rawLine.trim();
                if (line.length === 0)
                {
                    return;
                }

                const parsedRecord = JSON.parse(line);

                if (parsedRecord.header === true)
                {
                    totalCount = typeof parsedRecord.totalCount === "number" ? parsedRecord.totalCount : 0;
                    serverTime = typeof parsedRecord.serverTime === "number" ? parsedRecord.serverTime : Date.now();
                    if (onProgress)
                    {
                        onProgress(0, totalCount);
                    }
                    return;
                }

                switch (parsedRecord.type)
                {
                    case entityTypes.DECK:
                    {
                        decks.push(parsedRecord.data);
                        break;
                    }
                    case entityTypes.CARD:
                    {
                        cards.push(parsedRecord.data);
                        break;
                    }
                    case entityTypes.STUDY_MATERIAL:
                    {
                        studyMaterials.push(parsedRecord.data);
                        break;
                    }
                    case entityTypes.MOCK_TEST:
                    {
                        mockTests.push(parsedRecord.data);
                        break;
                    }
                    case entityTypes.ASK_AI_POPUP_LINK:
                    {
                        popupLinks.push(parsedRecord.data);
                        break;
                    }
                    default:
                    {
                        break;
                    }
                }

                processedCount++;

                if (onProgress && (processedCount % SyncTransport.#BULK_SNAPSHOT_PROGRESS_BATCH_SIZE === 0))
                {
                    // Clamp the denominator so the bar never visually
                    // overshoots if the cursor outpaces the header count
                    // (server-side mismatch, retry collision, etc.) —
                    // bars going past 100% read as broken even though
                    // they are recoverable.
                    const denominator = Math.max(totalCount, processedCount);
                    onProgress(processedCount, denominator);
                }
            };

            const reader  = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer    = "";

            while (true)
            {
                const { value, done } = await reader.read();
                if (done)
                {
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf("\n")) >= 0)
                {
                    const line = buffer.slice(0, newlineIndex);
                    buffer = buffer.slice(newlineIndex + 1);
                    handleLine(line);
                }
            }

            const trailingBytes = decoder.decode();
            if (trailingBytes)
            {
                buffer += trailingBytes;
            }
            if (buffer.length > 0)
            {
                handleLine(buffer);
            }

            clearTimeout(timeoutId);

            if (onProgress)
            {
                // Stream completed cleanly — force the bar to 100% so
                // the "Restoring sync state" dialog dismisses even if
                // the header's promised count and the actual streamed
                // count disagree. Any callers downstream still get the
                // accurate processedCount in the returned object below.
                const finalCount = Math.max(totalCount, processedCount);
                onProgress(finalCount, finalCount);
            }

            return { decks, cards, studyMaterials, mockTests, popupLinks, serverTime, totalCount };
        }
        catch (bulkSnapshotError)
        {
            clearTimeout(timeoutId);

            if (bulkSnapshotError.name === "AbortError")
            {
                console.warn(`[SyncTransport] /Sync/BulkSnapshot timed out after ${SyncTransport.#BULK_SNAPSHOT_TIMEOUT_MILLISECONDS / 1000}s.`);
            }
            else
            {
                console.error("[SyncTransport] /Sync/BulkSnapshot failed:", bulkSnapshotError);
            }

            return null;
        }
    }

    // ── Push ──────────────────────────────────────────────────────────

    /**
     * Sends the local pendingChanges to the server in chunks of
     * #CHUNK_SIZE. The final chunk carries `isLastChunk: true`, which is
     * the signal that the server should run the pull phase and return
     * server-side changes for us to apply.
     *
     * Ordering rule: upsert records are sorted before deletion records,
     * and chunks run sequentially whenever any deletion is in the push.
     * Each /Sync POST runs its own deletion cascade server-side
     * (bulkRecordDeletions), and that cascade reads each entity
     * collection's current state — so a deletion chunk landing before
     * an upsert chunk that re-parents the same entity would let the
     * cascade tombstone the just-moved entity. Pure-upsert pushes
     * (initial sync, study-progress flushes) keep the old parallel
     * fast path. The within-chunk ordering is enforced server-side by
     * Sync.js, which awaits all upserts before running bulkRecordDeletions.
     *
     * Returns the response from the final chunk (containing
     * `changes`, `deletions`, `serverTime`) or null on transport failure.
     */
    static async pushInChunks(changes, onChunkComplete = null)
    {
        // Paid decks ride the normal sync wire now — their content is already
        // ciphertext (envelopes) and the server preserves its plaintext copy,
        // so there is nothing to filter out here. Progress on a paid card syncs
        // exactly like progress on a normal card.

        // Sort upserts first, deletions last. Stable enough — sort key
        // is just the boolean `deleted` flag, and we don't depend on
        // any relative order within either group.
        const orderedChanges = [...changes].sort((firstChange, secondChange) =>
        {
            const firstIsDeletion  = firstChange?.deleted  ? 1 : 0;
            const secondIsDeletion = secondChange?.deleted ? 1 : 0;
            return firstIsDeletion - secondIsDeletion;
        });

        const bHasDeletions = orderedChanges.some((change) => change?.deleted === true);

        const totalChunks = Math.ceil(orderedChanges.length / SyncTransport.#CHUNK_SIZE) || 1;

        if (totalChunks === 1)
        {
            const onlyChunk = orderedChanges.slice(0, SyncTransport.#CHUNK_SIZE);
            const response  = await SyncTransport.#postSyncChunk(onlyChunk, true);

            if (onChunkComplete)
            {
                onChunkComplete();
            }

            return response;
        }

        // Multi-chunk path — intermediates either in parallel (pure
        // upsert) or sequential (any deletion in the push). Final chunk
        // always runs last so the server's pull phase only fires once
        // all data is ingested.
        const intermediateChunks = [];

        for (let chunkIndex = 0; chunkIndex < totalChunks - 1; chunkIndex++)
        {
            intermediateChunks.push(orderedChanges.slice(
                chunkIndex * SyncTransport.#CHUNK_SIZE,
                (chunkIndex + 1) * SyncTransport.#CHUNK_SIZE,
            ));
        }

        if (bHasDeletions)
        {
            // Sequential: deletion chunk's cascade must observe every
            // earlier chunk's upserts.
            for (let chunkIndex = 0; chunkIndex < intermediateChunks.length; chunkIndex++)
            {
                const chunk       = intermediateChunks[chunkIndex];
                const chunkNumber = chunkIndex + 1;
                const response    = await SyncTransport.#postSyncChunk(chunk, false);

                if (!response)
                {
                    console.error(`[SyncTransport] Chunk ${chunkNumber}/${totalChunks} failed (sequential mode).`);
                    return null;
                }

                if (onChunkComplete)
                {
                    onChunkComplete();
                }
            }
        }
        else
        {
            // Pure-upsert fast path: send intermediate chunks in
            // bounded-parallel batches of #PARALLEL_CHUNK_LIMIT.
            for (let batchStart = 0; batchStart < intermediateChunks.length; batchStart += SyncTransport.#PARALLEL_CHUNK_LIMIT)
            {
                const batchEnd      = Math.min(batchStart + SyncTransport.#PARALLEL_CHUNK_LIMIT, intermediateChunks.length);
                const batchPromises = [];

                for (let chunkIndex = batchStart; chunkIndex < batchEnd; chunkIndex++)
                {
                    const chunk       = intermediateChunks[chunkIndex];
                    const chunkNumber = chunkIndex + 1;

                    batchPromises.push(SyncTransport.#postSyncChunk(chunk, false).then((response) =>
                    {
                        if (!response)
                        {
                            throw new Error(`Chunk ${chunkNumber}/${totalChunks} failed.`);
                        }

                        if (onChunkComplete)
                        {
                            onChunkComplete();
                        }
                    }));
                }

                try
                {
                    await Promise.all(batchPromises);
                }
                catch (batchError)
                {
                    console.error(`[SyncTransport] Parallel chunk batch failed: ${batchError.message}`);
                    return null;
                }
            }
        }

        const finalChunk    = orderedChanges.slice((totalChunks - 1) * SyncTransport.#CHUNK_SIZE, totalChunks * SyncTransport.#CHUNK_SIZE);
        const finalResponse = await SyncTransport.#postSyncChunk(finalChunk, true);

        if (onChunkComplete)
        {
            onChunkComplete();
        }

        return finalResponse;
    }

    static getChunkSize()
    {
        return SyncTransport.#CHUNK_SIZE;
    }

    static #postSyncChunk(chunkChanges, bIsLastChunk)
    {
        return fetchPostJsonWithTimeout(
            SyncTransport.#SYNC_ENDPOINT_PATH,
            {
                lastSync:    SyncTransport.#lastSyncTimestamp,
                deviceId:    SyncTransport.#deviceId,
                changes:     chunkChanges,
                isLastChunk: bIsLastChunk,
            },
            SyncTransport.#NETWORK_TIMEOUT_MILLISECONDS,
        );
    }
}

export default SyncTransport;
