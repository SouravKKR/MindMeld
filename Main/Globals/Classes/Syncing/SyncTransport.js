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
     * Reference-aware counterpart to `clearPendingChanges`. Used at the
     * end of a successful push: remove the entries that were actually
     * sent, but only when `pendingChanges` still holds the exact record
     * the push captured in its snapshot.
     *
     * If a new change landed at the same id during the push (e.g. the
     * user deleted a just-imported deck while the upsert was in flight),
     * the entry was replaced with a fresh reference. The reference
     * compare below leaves that new record in place so the next cycle
     * pushes it. The previous wholesale clear silently dropped such
     * records, leaving the server's view of the entity stuck on the
     * pre-delete upsert.
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
            if (currentRecord === pushedChange)
            {
                delete SyncTransport.#pendingChanges[pushedChange.entityId];
            }
        }
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
     *   { decks, cards, studyMaterials, mockTests, serverTime, totalCount }
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
                    default:
                    {
                        break;
                    }
                }

                processedCount++;

                if (onProgress && (processedCount % SyncTransport.#BULK_SNAPSHOT_PROGRESS_BATCH_SIZE === 0))
                {
                    onProgress(processedCount, totalCount);
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
                onProgress(processedCount, totalCount || processedCount);
            }

            return { decks, cards, studyMaterials, mockTests, serverTime, totalCount };
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
     * server-side changes for us to apply. For multi-chunk pushes the
     * intermediate chunks are sent in parallel batches of
     * #PARALLEL_CHUNK_LIMIT.
     *
     * Returns the response from the final chunk (containing
     * `changes`, `deletions`, `serverTime`) or null on transport failure.
     */
    static async pushInChunks(changes, onChunkComplete = null)
    {
        const totalChunks = Math.ceil(changes.length / SyncTransport.#CHUNK_SIZE) || 1;

        if (totalChunks === 1)
        {
            const onlyChunk = changes.slice(0, SyncTransport.#CHUNK_SIZE);
            const response  = await SyncTransport.#postSyncChunk(onlyChunk, true);

            if (onChunkComplete)
            {
                onChunkComplete();
            }

            return response;
        }

        // Multi-chunk path — intermediates in parallel, final chunk last
        // so the server's pull phase only fires once all data is ingested.
        const intermediateChunks = [];

        for (let chunkIndex = 0; chunkIndex < totalChunks - 1; chunkIndex++)
        {
            intermediateChunks.push(changes.slice(
                chunkIndex * SyncTransport.#CHUNK_SIZE,
                (chunkIndex + 1) * SyncTransport.#CHUNK_SIZE,
            ));
        }

        for (let batchStart = 0; batchStart < intermediateChunks.length; batchStart += SyncTransport.#PARALLEL_CHUNK_LIMIT)
        {
            const batchEnd     = Math.min(batchStart + SyncTransport.#PARALLEL_CHUNK_LIMIT, intermediateChunks.length);
            const batchPromises = [];

            for (let chunkIndex = batchStart; chunkIndex < batchEnd; chunkIndex++)
            {
                const chunk        = intermediateChunks[chunkIndex];
                const chunkNumber  = chunkIndex + 1;

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

        const finalChunk    = changes.slice((totalChunks - 1) * SyncTransport.#CHUNK_SIZE, totalChunks * SyncTransport.#CHUNK_SIZE);
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
