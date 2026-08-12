import { localLlmDownloadStates } from "../../Enumerations/LocalLlmDownloadStates.js";
import LocalLlmDownloadConstants from "../../Constants/LocalLlmDownloadConstants.js";
import LocalLlmDownloadEvents from "../../Events/LocalLlmDownloadEvents.js";
import Persistence from "../Persistence.js";
import { dataFormats } from "../../Enumerations/DataFormats.js";


/**
 * LocalLlmModelInventory
 *
 * What this device holds, PER MODEL.
 *
 * It replaces a single device-wide download record that could only ever
 * describe one model at a time — `{ state, modelKey, fraction }`. That shape
 * could not represent the ordinary situation of owning the 1.5B, downloading
 * the 3B, and wanting to keep using the 1.5B in the meantime, and the symptom
 * was precise: switching to an already-downloaded model mid-download read back
 * the OTHER model's DOWNLOADING record, reconciled it to NOT_STARTED, and
 * announced that the Free tier needed a download — while the cached weights
 * loaded and answered perfectly. The state was wrong, not the engine.
 *
 * So the record is keyed by model. A model's presence is a fact about that
 * model, and nothing another model does can change it.
 *
 * DISK IS THE AUTHORITY, NOT THIS FILE. A record here says the app believes
 * the weights are present; the weights themselves live in a browser-managed
 * store or the app's data directory, both of which can be cleared without this
 * code being told. So a READY record is a strong hint, verified against the
 * driver when it matters (`LocalLlmCapability.reconcileAgainstStorage`), never
 * a guarantee. The opposite mistake — treating this as authoritative — is what
 * makes an app insist a deleted model is present.
 *
 * Device-scoped, like everything else describing the weights: they sit in a
 * store every identity on the machine shares, so which ones exist is a fact
 * about the hardware rather than about the person signed in. See
 * UserIdentityConstants.GLOBAL_KEYS.
 */
class LocalLlmModelInventory
{
    // Bumped only when the stored shape changes incompatibly. Present from the
    // first version so a later migration has something to branch on rather
    // than having to guess from the shape.
    static SCHEMA_VERSION = 1;

    static #recordsByModelKey = new Map();
    static #hydratePromise = null;

    /**
     * Reads the stored inventory once, migrating the legacy single record if
     * that is all this device has.
     */
    static hydrate()
    {
        if (LocalLlmModelInventory.#hydratePromise)
        {
            return LocalLlmModelInventory.#hydratePromise;
        }

        LocalLlmModelInventory.#hydratePromise = (async () =>
        {
            try
            {
                const bExists = await Persistence.exists(
                    LocalLlmDownloadConstants.LOCAL_MODEL_INVENTORY_PERSISTENCE_KEY
                );

                if (bExists)
                {
                    const storedInventory = await Persistence.read(
                        LocalLlmDownloadConstants.LOCAL_MODEL_INVENTORY_PERSISTENCE_KEY,
                        dataFormats.JSON
                    );
                    LocalLlmModelInventory.#adoptStoredInventory(storedInventory);
                    return;
                }

                await LocalLlmModelInventory.#migrateLegacyRecord();
            }
            catch (readError)
            {
                console.warn(`[LocalLlmModelInventory] Could not read the inventory: ${readError?.message || readError}`);
                LocalLlmModelInventory.#recordsByModelKey = new Map();
            }
        })();

        return LocalLlmModelInventory.#hydratePromise;
    }

    static #adoptStoredInventory(storedInventory)
    {
        LocalLlmModelInventory.#recordsByModelKey = LocalLlmModelInventory.interpretStoredInventory(storedInventory);
    }

    /**
     * Turns what was on disk into the in-memory records, applying the one rule
     * that cannot be deferred to a later check.
     *
     * Pure, and public for that reason: it is the whole of the boot-time
     * interpretation, and a verification run can exercise it directly without
     * a browser, a storage layer or a device. The rest of this class is I/O
     * around it.
     */
    static interpretStoredInventory(storedInventory)
    {
        const interpretedRecords = new Map();

        const storedModels = storedInventory && typeof storedInventory.models === "object" && storedInventory.models !== null
            ? storedInventory.models
            : {};

        for (const [modelKey, storedRecord] of Object.entries(storedModels))
        {
            if (!storedRecord || typeof storedRecord.state !== "number")
            {
                continue;
            }

            // A DOWNLOADING record can only ever be stale. A download runs in
            // the page (or in a command this page issued) and cannot outlive
            // it, so finding one on disk means the previous session was killed
            // mid-fetch, not that something is still running. Left as-is it
            // renders as a progress bar that never moves and a Download button
            // that refuses to start because one is "already in progress".
            //
            // The fraction is kept rather than zeroed: the native path resumes
            // from a .partial file, so the next attempt genuinely does start
            // from about there, and reconcileAgainstStorage may yet find the
            // file complete and promote this straight to READY.
            const adoptedState = storedRecord.state === localLlmDownloadStates.DOWNLOADING
                ? localLlmDownloadStates.NOT_STARTED
                : storedRecord.state;

            interpretedRecords.set(modelKey,
            {
                state: adoptedState,
                fraction: typeof storedRecord.fraction === "number" ? storedRecord.fraction : 0,
                totalBytes: typeof storedRecord.totalBytes === "number" ? storedRecord.totalBytes : 0,
                errorMessage: typeof storedRecord.errorMessage === "string" ? storedRecord.errorMessage : null,
                updatedAt: typeof storedRecord.updatedAt === "number" ? storedRecord.updatedAt : 0,
            });
        }

        return interpretedRecords;
    }

    /**
     * Whether a pre-inventory device's single download record describes
     * weights that are actually present, and so should carry across.
     *
     * Pure and public for the same reason as the interpretation above: getting
     * this wrong costs every existing device a re-download it does not need,
     * which is the most expensive mistake available here and the one worth
     * proving rather than assuming.
     */
    static isLegacyRecordWorthMigrating(legacyRecord)
    {
        return Boolean(legacyRecord)
            && legacyRecord.state === localLlmDownloadStates.READY
            && typeof legacyRecord.modelKey === "string"
            && legacyRecord.modelKey.length > 0;
    }

    /**
     * Carries a pre-inventory device across without re-downloading.
     *
     * The old record named exactly one model and, if it said READY, that model
     * genuinely is on the device — hundreds of megabytes to two gigabytes of
     * it. Dropping the record because the shape changed would present a fresh
     * download for weights already sitting there, which is the single most
     * expensive mistake this migration could make.
     *
     * Only READY is carried. A DOWNLOADING record describes a fetch that was
     * killed mid-flight with an unknown amount salvaged, and FAILED describes
     * something that never arrived — neither is evidence of presence, and both
     * are cheap to rediscover.
     */
    static async #migrateLegacyRecord()
    {
        const bLegacyExists = await Persistence.exists(LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY);
        if (!bLegacyExists)
        {
            return;
        }

        const legacyRecord = await Persistence.read(
            LocalLlmDownloadConstants.LOCAL_STATE_PERSISTENCE_KEY,
            dataFormats.JSON
        );

        if (!LocalLlmModelInventory.isLegacyRecordWorthMigrating(legacyRecord))
        {
            return;
        }

        console.log(`[LocalLlmModelInventory] Migrating the legacy download record for "${legacyRecord.modelKey}" into the per-model inventory.`);

        LocalLlmModelInventory.#recordsByModelKey.set(legacyRecord.modelKey,
        {
            state: localLlmDownloadStates.READY,
            fraction: 1,
            totalBytes: typeof legacyRecord.totalBytes === "number" ? legacyRecord.totalBytes : 0,
            errorMessage: null,
            updatedAt: typeof legacyRecord.lastTransitionAt === "number" ? legacyRecord.lastTransitionAt : Date.now(),
        });

        await LocalLlmModelInventory.#persist();
    }

    /**
     * This model's state on this device. NOT_STARTED when nothing is recorded,
     * which is the correct reading of "no evidence it was ever fetched".
     */
    static getState(modelKey)
    {
        const record = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);
        return record ? record.state : localLlmDownloadStates.NOT_STARTED;
    }

    static getRecord(modelKey)
    {
        const record = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);
        return record ? { ...record } : null;
    }

    static getProgressFraction(modelKey)
    {
        const record = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);
        return record && typeof record.fraction === "number" ? record.fraction : 0;
    }

    static getErrorMessage(modelKey)
    {
        const record = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);
        return record ? record.errorMessage : null;
    }

    static isDownloaded(modelKey)
    {
        return LocalLlmModelInventory.getState(modelKey) === localLlmDownloadStates.READY;
    }

    /**
     * Every model recorded READY, in no particular order. Used to pick a
     * replacement when the model in use is deleted — switching to something
     * already on the device beats switching to something that needs a
     * gigabyte fetched first.
     */
    static listDownloadedModelKeys()
    {
        const downloadedModelKeys = [];

        for (const [modelKey, record] of LocalLlmModelInventory.#recordsByModelKey.entries())
        {
            if (record.state === localLlmDownloadStates.READY)
            {
                downloadedModelKeys.push(modelKey);
            }
        }

        return downloadedModelKeys;
    }

    /**
     * Whether any model is mid-download right now.
     *
     * Read by the table to keep a second download from being started
     * alongside the first: they compete for the same bandwidth and the same
     * memory, and two half-finished models is a worse position than one
     * finished one.
     */
    static getDownloadingModelKey()
    {
        for (const [modelKey, record] of LocalLlmModelInventory.#recordsByModelKey.entries())
        {
            if (record.state === localLlmDownloadStates.DOWNLOADING)
            {
                return modelKey;
            }
        }
        return null;
    }

    /**
     * Records a state transition for one model and persists the whole
     * inventory.
     *
     * `bSilent` suppresses the change event for the high-frequency progress
     * path: a re-render per percentage point of a two-gigabyte download is
     * work nobody sees. The table polls the fraction while a download is
     * running instead.
     */
    static async setState(modelKey, state, extra = {})
    {
        if (typeof modelKey !== "string" || modelKey.length === 0)
        {
            return;
        }

        const existingRecord = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);

        LocalLlmModelInventory.#recordsByModelKey.set(modelKey,
        {
            state: state,
            fraction: typeof extra.fraction === "number"
                ? extra.fraction
                : (existingRecord ? existingRecord.fraction : 0),
            totalBytes: typeof extra.totalBytes === "number"
                ? extra.totalBytes
                : (existingRecord ? existingRecord.totalBytes : 0),
            errorMessage: extra.errorMessage !== undefined
                ? extra.errorMessage
                : (existingRecord ? existingRecord.errorMessage : null),
            updatedAt: Date.now(),
        });

        await LocalLlmModelInventory.#persist();

        if (extra.bSilent !== true)
        {
            LocalLlmModelInventory.#announceChange(modelKey);
        }
    }

    /**
     * Updates the in-memory progress fraction without a write.
     *
     * Deliberately not persisted: a download reports progress many times a
     * second, and every write goes through BSON serialisation to IndexedDB or
     * the app's data directory. The fraction is flushed by the next real state
     * change, and a fraction lost to a crash costs nothing — an interrupted
     * download is re-verified against storage on the next run regardless.
     */
    static updateProgress(modelKey, fraction)
    {
        const record = LocalLlmModelInventory.#recordsByModelKey.get(modelKey);
        if (record)
        {
            record.fraction = fraction;
        }
    }

    /**
     * Forgets a model, after its weights have actually been removed.
     *
     * Called BY the deletion path, never instead of it. Removing the record
     * alone would leave the bytes on disk with nothing referencing them —
     * invisible to the app, still occupying the space the learner was trying
     * to reclaim, and silently re-adopted the next time that model was
     * selected.
     */
    static async forget(modelKey)
    {
        if (!LocalLlmModelInventory.#recordsByModelKey.has(modelKey))
        {
            return;
        }

        LocalLlmModelInventory.#recordsByModelKey.delete(modelKey);
        await LocalLlmModelInventory.#persist();
        LocalLlmModelInventory.#announceChange(modelKey);
    }

    static #announceChange(modelKey)
    {
        window.dispatchEvent(new CustomEvent(LocalLlmDownloadEvents.INVENTORY_CHANGED,
        {
            detail: { modelKey: modelKey, state: LocalLlmModelInventory.getState(modelKey) }
        }));
    }

    static async #persist()
    {
        const serialisableModels = {};

        for (const [modelKey, record] of LocalLlmModelInventory.#recordsByModelKey.entries())
        {
            serialisableModels[modelKey] = record;
        }

        try
        {
            await Persistence.write(
                LocalLlmDownloadConstants.LOCAL_MODEL_INVENTORY_PERSISTENCE_KEY,
                { version: LocalLlmModelInventory.SCHEMA_VERSION, models: serialisableModels },
                dataFormats.JSON
            );
        }
        catch (writeError)
        {
            // The in-memory map already changed, so this session behaves
            // correctly either way; only carrying it to the next one is lost.
            console.warn(`[LocalLlmModelInventory] Could not persist the inventory: ${writeError?.message || writeError}`);
        }
    }
}

export default LocalLlmModelInventory;
