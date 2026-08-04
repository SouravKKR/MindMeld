import AuthenticationEvents from "../../Events/AuthenticationEvents.js";
import DeckEvents from "../../Events/DeckEvents.js";
import SyncEvents from "../../Events/SyncEvents.js";
import UserIdentityEvents from "../../Events/UserIdentityEvents.js";
import { syncStates } from "../../Enumerations/SyncStates.js";
import { createPromiseMutex } from "../../UtilityFunctions/CreatePromiseMutex.js";
import ActiveEntityTracker from "../ActiveEntityTracker.js";
import Deck from "../../Model/Deck.js";
import PageNavigator from "../PageNavigator.js";
import UserIdentityManager from "../UserIdentityManager.js";
import SyncApplier from "./SyncApplier.js";
import SyncProgressReporter from "./SyncProgressReporter.js";
import SyncTransport from "./SyncTransport.js";
import SyncBlockingDialog from "../../../CommonComponents/SyncBlockingDialog.js";
import TermsAndConditionsManager from "../TermsAndConditionsManager.js";


/**
 * SyncOrchestrator
 *
 * Drives the high-level sync flow: lifecycle gates (decks loaded +
 * authenticated), the main sync() state machine, debounced and periodic
 * triggers, connection-quality gating, and progress-bar weighting
 * across each phase. Coordinates SyncTransport (network I/O),
 * SyncApplier (server-change hydration), and SyncProgressReporter
 * (animations).
 *
 * Exposed via the SyncManager facade.
 */
class SyncOrchestrator
{
    // ── Timing ────────────────────────────────────────────────────────
    static #SYNC_INTERVAL_MILLISECONDS       = 5 * 60 * 1000;
    static #STALE_THRESHOLD_MILLISECONDS     = 30 * 24 * 60 * 60 * 1000;
    static #DEBOUNCE_SYNC_DELAY_MILLISECONDS = 3 * 1000;

    // Init-sync gate: if the page is just being reopened and we synced
    // recently with nothing left to push, skip the boot-time sync — the
    // 5-minute periodic will catch any other-device updates. Avoids the
    // "Syncing X%" flicker every time the user reloads the tab.
    static #INIT_SYNC_SKIP_THRESHOLD_MS      = 5 * 60 * 1000;

    // ── Progress-bar weighting per phase ──────────────────────────────
    static #PROGRESS_WEIGHT_LOCK            = 0.02;
    static #PROGRESS_WEIGHT_PUSH            = 0.40;
    static #PROGRESS_WEIGHT_APPLY           = 0.40;
    static #PROGRESS_WEIGHT_DELETE          = 0.08;
    static #PROGRESS_WEIGHT_FLUSH           = 0.10;
    static #PUSH_ANIMATION_EXPECTED_MS      = 3000;
    static #PHASE_TRANSITION_MS             = 220;
    static #TRIVIAL_TAIL_ANIMATION_MS       = 700;

    // ── Push-phase visual ceiling ─────────────────────────────────────
    //
    // The HTTP request that carries the final push chunk also does the
    // server-side pull, which can be slow on the first chunked cycle.
    // If we point the asymptotic crawl at exactly `pushPhaseEnd`, the
    // bar gets within a fraction of a percent of the boundary in ~3 s
    // and then looks frozen for the rest of the wait. Raising the
    // visual ceiling above `pushPhaseEnd` lets the crawl keep visibly
    // advancing into "apply territory" while we wait, and the chunk-
    // complete handler is forward-only so the response arriving never
    // snaps the bar backwards.
    static #PUSH_VISUAL_OVERSHOOT          = 0.18;

    // ── Tail-phase glide ──────────────────────────────────────────────
    //
    // Apply + delete + flush together can race through the bar in a
    // handful of ms when the pulled batch is small (e.g. each ~500-
    // entity chunked pull). Glide from the current fraction to 0.96
    // over a duration scaled to the actual workload, then snap to 1.0
    // when the real work finishes — guarantees a smooth tail without
    // ever reporting "done" before the apply chain has resolved.
    static #TAIL_GLIDE_MIN_MS              = 800;
    static #TAIL_GLIDE_MAX_MS              = 3500;
    static #TAIL_GLIDE_MS_PER_ENTITY       = 1.0;
    static #TAIL_GLIDE_HOLD_FRACTION       = 0.96;

    // ── Chunked-drain state ───────────────────────────────────────────
    //
    // When the server returns `morePending: true`, the cycle is one
    // chunk of a multi-cycle drain. Across the drain we want a single
    // continuous bar driven by entities applied / total estimated, no
    // `Synced` toast between chunks, and the bar not snapping back to
    // 0 when the next cycle's `sync()` starts. `DRAIN_PROGRESS_CAP`
    // keeps the entity-driven bar a hair under 100 % so the final
    // (non-chunked) cycle's apply still has visible room to settle to
    // 1.0 when the drain finishes.
    static #DRAIN_PROGRESS_CAP             = 0.92;
    static #DRAIN_CYCLE_MIN_GLIDE_MS       = 600;

    static #bInChunkedDrain          = false;
    static #processedDrainEntities   = 0;
    static #totalDrainEntities       = 0;
    // Every entity key ("<entityType>:<entityId>") this drain has already
    // applied. The server cannot trim decks to the chunk cursor — the client
    // needs the whole deck topology in one cycle to attach children — so a
    // deck delivered early in a drain is re-sent by later cycles. Counting raw
    // response lengths therefore inflated `#processedDrainEntities` on every
    // round trip, and since the total is derived from it, the "X / Y items"
    // denominator climbed instead of counting down. Keying on distinct
    // entities makes both numbers reflect real progress regardless of how
    // often a row is re-delivered.
    static #drainProcessedEntityKeys = new Set();
    // Sum of (changes + deletions) the server has returned for this
    // sync run — whether it was one cycle or a multi-cycle drain. We
    // use this at the final cycle to detect the "everything was empty"
    // case and decide whether to fire one auto-retry from epoch.
    static #pulledEntityCountThisRun = 0;
    // One-shot guard for the auto-retry from epoch: if a sync completed
    // with both an empty server-side pull AND an empty local library,
    // we re-run sync({bForce}) once with `lastSync = 0` in case a
    // corrupted cutoff was the cause. After that one retry, if the
    // result is still empty, accept the empty state and stop.
    static #bAutoForcePullAttempted  = false;
    // One-shot guard for the full-library-push → bulk-snapshot reroute (see
    // #runSyncCycle). Set when the reroute fires, cleared when either the bulk
    // pull succeeds or an ordinary drain runs to completion, so a bail-out can
    // never bounce between the two paths.
    static #bBulkSnapshotResyncAttempted = false;

    // ── Connection-quality strings (no magic strings leak out) ────────
    static #CONNECTION_ISSUE_OFFLINE        = "offline";
    static #CONNECTION_ISSUE_SLOW           = "slow";
    static #CONNECTION_ISSUE_SAVE_DATA      = "save-data";
    static #SLOW_EFFECTIVE_TYPES            = new Set(["slow-2g", "2g"]);

    static #syncMutex = createPromiseMutex();

    // Active SyncBlockingDialog instance — null when no force pull/push
    // is in flight. Singleton so the multi-cycle drain path (which
    // calls sync() recursively per chunk) doesn't stack modals.
    static #activeBlockingDialog = null;

    // Title strings for the blocking modal — kept as class constants
    // so they're not duplicated across forcePullFromServer and the
    // force-push detection branch in sync().
    static #FORCE_PULL_MODAL_TITLE = "Restoring your library";
    static #FORCE_PUSH_MODAL_TITLE = "Restoring sync state";

    static #state                    = syncStates.IDLE;
    static #periodicIntervalId       = null;
    static #debouncedSyncTimeoutId   = null;
    static #bApplyingServerChanges   = false;
    static #bDecksLoaded             = false;
    static #bAuthenticated           = false;
    static #bInitialized             = false;

    // ──────────────────────────────────────────────────────────────────
    //  Static initialiser — lifecycle event listeners
    // ──────────────────────────────────────────────────────────────────

    static
    {
        console.log("[SyncOrchestrator] Static initialiser running.");

        window.addEventListener(DeckEvents.CREATE, () =>
        {
            SyncOrchestrator.#bDecksLoaded = true;
            SyncOrchestrator.#tryInitialize();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            SyncOrchestrator.#bAuthenticated = true;
            SyncOrchestrator.#tryInitialize();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            SyncOrchestrator.#bAuthenticated = false;
            SyncOrchestrator.shutdown();
        });

        window.addEventListener("beforeunload", () =>
        {
            SyncTransport.saveSyncLog();
            SyncOrchestrator.#stopPeriodicSync();
        });

        // Any identity change wipes local sync state so the previous
        // user's pending changes don't bleed into a new identity.
        window.addEventListener(UserIdentityEvents.CHANGED, () =>
        {
            if (SyncOrchestrator.#bInitialized)
            {
                SyncOrchestrator.shutdown();
            }
        });

        // When the browser comes back online, drain pending changes
        // immediately instead of waiting for the next periodic tick.
        window.addEventListener("online", () =>
        {
            if (SyncOrchestrator.#bInitialized && SyncTransport.getPendingChangeCount() > 0)
            {
                SyncOrchestrator.#scheduleDebouncedSync();
            }
        });

        if (typeof navigator !== "undefined" && navigator.connection && typeof navigator.connection.addEventListener === "function")
        {
            navigator.connection.addEventListener("change", () =>
            {
                if (SyncOrchestrator.#bInitialized
                    && !SyncOrchestrator.#detectPoorConnection()
                    && SyncTransport.getPendingChangeCount() > 0)
                {
                    SyncOrchestrator.#scheduleDebouncedSync();
                }
            });
        }

        // The blocking-progress modal (when mounted) listens to the
        // standard sync events so its bar + label update without any
        // explicit per-cycle wiring. Mount is owned by the detection
        // points in `sync()` and `forcePullFromServer`; dismount on
        // success/failure happens here.
        window.addEventListener(SyncEvents.PROGRESS, (event) =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            const detail        = event.detail || {};
            const completedUnits = detail.completed || 0;
            const totalUnits     = detail.total     || 0;
            if (totalUnits > 0)
            {
                SyncOrchestrator.#activeBlockingDialog.updateFraction(completedUnits / totalUnits);
            }
        });

        window.addEventListener(SyncEvents.ENTITY_PROGRESS, (event) =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            const detail         = event.detail || {};
            const processedCount = detail.processed || 0;
            const totalCount     = detail.total     || 0;
            if (totalCount > 0)
            {
                SyncOrchestrator.#activeBlockingDialog.updateLabel(`${processedCount} / ${totalCount} items…`);
            }
            else if (processedCount > 0)
            {
                SyncOrchestrator.#activeBlockingDialog.updateLabel(`${processedCount} items…`);
            }
        });

        window.addEventListener(SyncEvents.COMPLETED, () =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            SyncOrchestrator.#activeBlockingDialog.markSuccessAndAutoClose();
            SyncOrchestrator.#activeBlockingDialog = null;
        });

        window.addEventListener(SyncEvents.FAILED, (event) =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            const errorDetail  = event.detail && event.detail.error;
            const errorMessage = errorDetail && errorDetail.message ? errorDetail.message : String(errorDetail || "");
            SyncOrchestrator.#activeBlockingDialog.markError(errorMessage);
            // Detach so a subsequent COMPLETED (e.g. from a retry) does
            // not auto-close the dialog the user is currently reading.
            SyncOrchestrator.#activeBlockingDialog = null;
        });

        // Lock-blocked escape hatch — mirrors SyncStatusComponent's Force
        // button. Without this the blocking modal would stay stuck on
        // "Preparing…" forever when another device (or a leaked TTL) is
        // holding the server-side lock. Gated on the same SyncEvents.LOCK_BLOCKED
        // condition the status component uses, so the dialog only offers
        // Force when the status pill would offer it.
        window.addEventListener(SyncEvents.LOCK_BLOCKED, () =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            SyncOrchestrator.#activeBlockingDialog.showForceAction(async () =>
            {
                await SyncOrchestrator.forceUnlockAndResync();
            });
        });

        // When a fresh cycle starts (the retry kicked off by the Force
        // button, or any subsequent normal cycle), drop the force action
        // back out of view — the lock is being re-attempted and the
        // user shouldn't be able to spam the button mid-flight.
        window.addEventListener(SyncEvents.STARTED, () =>
        {
            if (SyncOrchestrator.#activeBlockingDialog === null)
            {
                return;
            }
            SyncOrchestrator.#activeBlockingDialog.hideForceAction();
        });
    }

    // ──────────────────────────────────────────────────────────────────
    //  Public API (consumed via SyncManager facade)
    // ──────────────────────────────────────────────────────────────────

    static getState()
    {
        return SyncOrchestrator.#state;
    }

    static getDeviceId()
    {
        return SyncTransport.getDeviceId();
    }

    /**
     * User-triggered escape hatch for the "Sync lock not acquired"
     * case: clears the server-side lock (regardless of holder) and
     * fires a forced sync cycle.
     */
    static async forceUnlockAndResync()
    {
        console.warn("[SyncOrchestrator] User invoked forceUnlockAndResync.");
        try
        {
            const result = await SyncTransport.forceReleaseLock();
            console.warn(`[SyncOrchestrator] /Sync/ForceUnlock returned released=${result && result.released}, previousHolder=${result && result.previousHolderDeviceId}.`);
        }
        catch (forceUnlockError)
        {
            console.error("[SyncOrchestrator] forceReleaseLock failed:", forceUnlockError);
        }
        await SyncOrchestrator.sync({ bForce: true });
    }

    static async shutdown()
    {
        SyncOrchestrator.#stopPeriodicSync();

        if (SyncOrchestrator.#debouncedSyncTimeoutId)
        {
            clearTimeout(SyncOrchestrator.#debouncedSyncTimeoutId);
            SyncOrchestrator.#debouncedSyncTimeoutId = null;
        }

        SyncTransport.setLastSyncTimestamp(0);
        SyncTransport.clearPendingChanges();
        SyncOrchestrator.#bInitialized = false;
        SyncOrchestrator.#bAutoForcePullAttempted = false;
        SyncOrchestrator.#bBulkSnapshotResyncAttempted = false;
        SyncOrchestrator.#setState(syncStates.IDLE);

        await SyncTransport.saveSyncLog();
    }

    /**
     * options.bForce — bypass the connection-quality guard. Used by the
     * status component when the user manually clicks to sync.
     */
    static async sync(options = {})
    {
        const bForce = options.bForce === true;

        // Gate every sync cycle on legal acceptance. While the post-login
        // legal modal is still pending, the server 403s every sync endpoint
        // (LEGAL_ACCEPTANCE_REQUIRED) — and the non-dismissible force-push
        // modal mounted below would stack on top of the legal modal and trap
        // the user with no way to accept (or reach Log Out). Resolves
        // instantly once acceptance has settled, including for returning
        // users who already accepted.
        await TermsAndConditionsManager.whenLegalSettled();

        if (!Deck.getRoot())
        {
            console.warn("[SyncOrchestrator] sync() — Deck.getRoot() is null. Aborting.");
            return;
        }

        if (!window["user"])
        {
            console.warn("[SyncOrchestrator] sync() — user not authenticated. Aborting.");
            return;
        }

        if (!bForce)
        {
            const connectionIssue = SyncOrchestrator.#detectPoorConnection();
            if (connectionIssue)
            {
                console.warn(`[SyncOrchestrator] sync() — deferred due to connection: ${connectionIssue}.`);
                // Durably persist the pending queue before giving up on this
                // offline cycle. Every offline edit/delete debounce-fires a
                // sync that lands here, so this flushes the queue to disk
                // within a few seconds of the change — covering the case
                // reconciliation cannot (a delete: the entity is already gone
                // from local disk, so a later timestamp-scan can't rediscover
                // its tombstone; only a persisted queue entry survives a hard
                // close and still tells the server to remove it).
                try
                {
                    await SyncTransport.saveSyncLog();
                }
                catch (persistError)
                {
                    console.warn("[SyncOrchestrator] Failed to persist pending queue on deferred sync:", persistError);
                }
                window.dispatchEvent(new CustomEvent(SyncEvents.DEFERRED, { detail: { reason: connectionIssue } }));
                return;
            }
        }

        // Wipe-then-re-register safety net: if our last successful sync
        // predates the user's account, the server-side data was wiped
        // and the user record was recreated under a fresh joinDate. The
        // existing server-side `requestFullResync` handshake only fires
        // when the client happens to send an empty-changes cycle, so
        // recovery is deferred whenever there's a pending change. This
        // proactive client-side check resets `lastSync` to 0 so the
        // force-push branch below picks it up immediately and gathers
        // every local entity. After a successful push, `lastSync`
        // advances past `joinDate` and the condition stops firing —
        // no loop-prevention flag needed.
        // Same drain-safety rule as the stale-state check below: never reset
        // mid-drain. A chunked-drain continuation's cursor is the MIN overflow
        // watermark and can legitimately sit below joinDate while old data is
        // still draining; resetting it here would restart the drain from epoch
        // every continuation. Only judge the cursor on a fresh (non-drain)
        // cycle, where it genuinely represents the last successful sync.
        const currentLastSync = SyncTransport.getLastSyncTimestamp();
        const sessionUser     = window["user"];
        const userJoinDate    = sessionUser && typeof sessionUser.getJoinDate === "function"
            ? sessionUser.getJoinDate()
            : null;
        if (!SyncOrchestrator.#bInChunkedDrain
            && currentLastSync > 0
            && userJoinDate instanceof Date
            && !Number.isNaN(userJoinDate.getTime())
            && currentLastSync < userJoinDate.getTime())
        {
            console.warn(`[SyncOrchestrator] lastSync (${new Date(currentLastSync).toISOString()}) precedes user joinDate (${userJoinDate.toISOString()}) — likely server wipe + re-register. Resetting lastSync to force a full push.`);
            SyncTransport.setLastSyncTimestamp(0);
            await SyncTransport.saveSyncLog();
        }

        // Fresh-client fast path: lastSync = 0 (no prior sync state)
        // AND the local library is just the freshly-bootstrapped empty
        // root. Going through the chunked push/pull would fire several
        // round-trip cycles, each waiting on the server to scan + serialize
        // a slice of the user's account. The bulk-snapshot endpoint
        // returns every entity in one HTTP response and commits the tree
        // in a single IndexedDB transaction — the path Force Pull uses.
        // forcePullFromServer acquires the same mutex on its own, so we
        // route to it directly.
        // Force-push detection: lastSync === 0 (cycle is about to gather
        // every local entity and push them all) AND the local library
        // is non-empty (so it's not just one root deck — actually a
        // load of work). Mount the blocking modal before the cycle
        // starts; event listeners drive its bar/label. The drain-
        // continuation re-entries hit the singleton guard inside the
        // helper, so we don't stack modals across drain cycles.
        if (SyncTransport.getLastSyncTimestamp() === 0
            && !SyncOrchestrator.#isLocalLibraryEffectivelyEmpty())
        {
            SyncOrchestrator.#ensureBlockingDialog(SyncOrchestrator.#FORCE_PUSH_MODAL_TITLE);
        }

        if (SyncTransport.getLastSyncTimestamp() === 0
            && SyncOrchestrator.#isLocalLibraryEffectivelyEmpty())
        {
            console.log("[SyncOrchestrator] sync() — fresh client with empty local library; routing to bulk snapshot path.");
            await SyncOrchestrator.forcePullFromServer();

            // Truly-empty-server safety: the bulk path always advances
            // lastSync to the server's clock on success, even when the
            // snapshot was empty. In that case the local bootstrap root
            // exists but was never registered server-side. Roll lastSync
            // back to 0 so the next cycle's `gatherAllLocalEntities`
            // branch fires and pushes it.
            if (SyncOrchestrator.#isLocalLibraryEffectivelyEmpty()
                && SyncTransport.getLastSyncTimestamp() > 0)
            {
                console.log("[SyncOrchestrator] sync() — bulk snapshot returned an empty library; resetting lastSync so the next cycle pushes the local root.");
                SyncTransport.setLastSyncTimestamp(0);
                await SyncTransport.saveSyncLog();
            }
            return;
        }

        const releaseMutex = await SyncOrchestrator.#syncMutex.acquire();

        try
        {
            await SyncOrchestrator.#runSyncCycle();
        }
        catch (cycleError)
        {
            console.error("[SyncOrchestrator] Sync cycle failed with exception:", cycleError);
            SyncOrchestrator.#setState(syncStates.ERROR);
            window.dispatchEvent(new CustomEvent(SyncEvents.FAILED, { detail: { error: cycleError } }));
            SyncOrchestrator.#resetDrainState();
        }
        finally
        {
            SyncProgressReporter.stopAnimation();
            releaseMutex();
        }
    }

    // ──────────────────────────────────────────────────────────────────
    //  Initialisation
    // ──────────────────────────────────────────────────────────────────

    static async #tryInitialize()
    {
        if (SyncOrchestrator.#bInitialized)
        {
            return;
        }

        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        if (!SyncOrchestrator.#bDecksLoaded || !SyncOrchestrator.#bAuthenticated)
        {
            return;
        }

        SyncOrchestrator.#bInitialized = true;

        await SyncTransport.loadOrGenerateDeviceId();
        await SyncTransport.loadSyncLog();

        SyncOrchestrator.#registerEntityListeners();
        SyncOrchestrator.#startPeriodicSync();

        console.log(`[SyncOrchestrator] Initialised. Device=${SyncTransport.getDeviceId()}, lastSync=${SyncTransport.getLastSyncTimestamp()}, pending=${SyncTransport.getPendingChangeCount()}.`);

        // Skip the boot-time sync when there's genuinely nothing to do
        // and we synced recently — the periodic interval will still
        // catch any updates the user expects to pull from another
        // device. Without this guard, every page reload fires a sync
        // cycle whose only visible effect is the "Syncing X%" flicker.
        const lastSyncTimestamp = SyncTransport.getLastSyncTimestamp();
        const pendingCount      = SyncTransport.getPendingChangeCount();
        const millisSinceSync   = Date.now() - lastSyncTimestamp;

        if (pendingCount === 0
            && lastSyncTimestamp > 0
            && millisSinceSync < SyncOrchestrator.#INIT_SYNC_SKIP_THRESHOLD_MS)
        {
            console.log(`[SyncOrchestrator] Skipping init sync — last sync was ${Math.round(millisSinceSync / 1000)}s ago and nothing is pending.`);
            return;
        }

        SyncOrchestrator.sync();
    }

    // ──────────────────────────────────────────────────────────────────
    //  Entity-change listeners (push side)
    // ──────────────────────────────────────────────────────────────────

    static #registerEntityListeners()
    {
        window.addEventListener(SyncEvents.ENTITY_CHANGED, SyncOrchestrator.#handleEntityChanged);
        window.addEventListener(SyncEvents.ENTITY_DELETED, SyncOrchestrator.#handleEntityDeleted);
    }

    static #handleEntityChanged(event)
    {
        // Historical note: this handler used to early-return when
        // #bApplyingServerChanges was true, on the theory that any
        // ENTITY_CHANGED fired during the apply phase came from
        // SyncApplier.flushDirtyDecks persisting server state and
        // would otherwise echo back to the server on the next push.
        // The gate was too coarse — it also dropped legitimate user
        // mutations (delete, edit, study-progress writes) that
        // happened to coincide with an in-flight apply. Server-source
        // events are now suppressed at the dispatch site instead
        // (Deck.save / Deck.delete accept bSuppressDispatch=true; the
        // sync apply path passes true), so this handler can
        // unconditionally queue every event it receives.

        const detail = event.detail;

        SyncTransport.setPendingChange(detail.entityId,
        {
            entityId:   detail.entityId,
            entityType: detail.entityType,
            data:       detail.data,
            deleted:    false,
        });

        SyncOrchestrator.#scheduleDebouncedSync();
    }

    static #handleEntityDeleted(event)
    {
        // No apply-phase gate — see #handleEntityChanged for rationale.
        // SyncApplier.applyServerDeletions calls Deck.delete with
        // bSuppressDispatch=true, so server-source teardowns never
        // reach this handler in the first place.

        const detail = event.detail;

        SyncTransport.setPendingChange(detail.entityId,
        {
            entityId:   detail.entityId,
            entityType: detail.entityType,
            data:       null,
            deleted:    true,
        });

        SyncOrchestrator.#scheduleDebouncedSync();
    }

    static #scheduleDebouncedSync()
    {
        if (SyncOrchestrator.#debouncedSyncTimeoutId)
        {
            clearTimeout(SyncOrchestrator.#debouncedSyncTimeoutId);
        }

        SyncOrchestrator.#debouncedSyncTimeoutId = setTimeout(() =>
        {
            SyncOrchestrator.#debouncedSyncTimeoutId = null;
            SyncOrchestrator.sync();
        }, SyncOrchestrator.#DEBOUNCE_SYNC_DELAY_MILLISECONDS);
    }

    /**
     * Public wrapper for the debounced-sync scheduler.
     *
     * Bulk-loaders (currently Deck.import) need to schedule a sync after
     * directly populating SyncTransport.pendingChanges, because they
     * bypass the SyncEvents.ENTITY_CHANGED / ENTITY_DELETED handlers
     * (which would otherwise be silently dropped by the
     * #bApplyingServerChanges gate when those events happen to fire
     * while a sync's apply phase is running). Without this scheduler
     * call, the imported entities would just sit in pendingChanges
     * until the next periodic tick (up to 5 minutes later) or the next
     * unrelated entity change debounce-fires a sync.
     */
    static scheduleDebouncedSync()
    {
        SyncOrchestrator.#scheduleDebouncedSync();
    }

    /**
     * Public lease on the sync mutex.
     *
     * Multi-step model mutations that must not be observed mid-flight by
     * a sync cycle (currently Deck.mergeFrom — which moves cards /
     * materials / mocks across decks, saves the target, then deletes the
     * source over several `await` points) acquire this lease for the
     * full duration of the operation. The lease blocks any debounced or
     * periodic sync cycle from starting until the lease is released,
     * which means the next cycle observes the final post-merge state
     * exactly once instead of an intermediate "target has new children
     * but empty source still exists" snapshot.
     *
     * Returns the same release-function shape as the internal
     * `#syncMutex.acquire()` calls inside this class — call it from a
     * `finally` block to guarantee the lease is released even on error.
     */
    static acquireSyncMutex()
    {
        return SyncOrchestrator.#syncMutex.acquire();
    }

    static #startPeriodicSync()
    {
        if (SyncOrchestrator.#periodicIntervalId)
        {
            return;
        }

        SyncOrchestrator.#periodicIntervalId = setInterval(() =>
        {
            SyncOrchestrator.sync();
        }, SyncOrchestrator.#SYNC_INTERVAL_MILLISECONDS);
    }

    static #stopPeriodicSync()
    {
        if (SyncOrchestrator.#periodicIntervalId)
        {
            clearInterval(SyncOrchestrator.#periodicIntervalId);
            SyncOrchestrator.#periodicIntervalId = null;
        }
    }

    // ──────────────────────────────────────────────────────────────────
    //  State + connection detection
    // ──────────────────────────────────────────────────────────────────

    static #setState(state)
    {
        SyncOrchestrator.#state = state;
        window.dispatchEvent(new CustomEvent(SyncEvents.STATE_CHANGED, { detail: { state } }));
    }

    static #detectPoorConnection()
    {
        if (typeof navigator !== "undefined" && navigator.onLine === false)
        {
            return SyncOrchestrator.#CONNECTION_ISSUE_OFFLINE;
        }

        const connectionInformation = typeof navigator !== "undefined" ? navigator.connection : null;
        if (connectionInformation)
        {
            if (SyncOrchestrator.#SLOW_EFFECTIVE_TYPES.has(connectionInformation.effectiveType))
            {
                return SyncOrchestrator.#CONNECTION_ISSUE_SLOW;
            }
            if (connectionInformation.saveData === true)
            {
                return SyncOrchestrator.#CONNECTION_ISSUE_SAVE_DATA;
            }
        }

        return null;
    }

    // ──────────────────────────────────────────────────────────────────
    //  Main sync cycle — driven by sync()
    // ──────────────────────────────────────────────────────────────────

    static async #runSyncCycle()
    {
        // Cancel any queued debounced sync — this cycle is about to
        // consume every record in pendingChanges, so a subsequent
        // timer firing with the queue already drained would just be a
        // spurious empty cycle the user sees as "Syncing... Synced".
        // Any change that lands mid-cycle re-arms a fresh timer via
        // the entity-changed / entity-deleted handlers, so we never
        // lose the trigger for genuinely-pending work.
        if (SyncOrchestrator.#debouncedSyncTimeoutId)
        {
            clearTimeout(SyncOrchestrator.#debouncedSyncTimeoutId);
            SyncOrchestrator.#debouncedSyncTimeoutId = null;
        }

        // Consume any pending "reset lastSync to 0" request that
        // forcePullFromServer queued. We do this BEFORE reading
        // lastSync, so the cycle's pull starts from epoch as intended.
        // The flag handshake is what makes forcePullFromServer race-
        // free against a previously in-flight sync overwriting
        // lastSync with its own serverTime.
        const bResetConsumed = SyncTransport.consumeLastSyncResetRequest();
        if (bResetConsumed)
        {
            console.warn("[SyncOrchestrator] Consuming queued lastSync reset — pulling from epoch.");
            // The reset implies the user (or auto-retry) explicitly
            // wants to start fresh; any drain state from a previous
            // cycle is moot.
            SyncOrchestrator.#bInChunkedDrain        = false;
            SyncOrchestrator.#processedDrainEntities = 0;
            SyncOrchestrator.#totalDrainEntities     = 0;
            SyncOrchestrator.#pulledEntityCountThisRun = 0;
            await SyncTransport.saveSyncLog();
        }

        const bResumingDrain = SyncOrchestrator.#bInChunkedDrain;

        SyncOrchestrator.#setState(syncStates.SYNCING);

        // Suppress the STARTED event on drain continuations — the UI is
        // already showing a SYNCING state from the first cycle and we
        // don't want to flicker the spinner / progress label.
        if (!bResumingDrain)
        {
            window.dispatchEvent(new CustomEvent(SyncEvents.STARTED));
        }

        // Stale-state detection — reset to full sync if last sync is ancient.
        //
        // CRITICAL: never during a chunked-drain continuation. Mid-drain the
        // cursor is the MIN overflow watermark — the server returns the
        // oldest-pending collection first (serverTime = min(overflowWatermarks)
        // in Sync.js), so while a backlog is draining the cursor legitimately
        // points at data far older than the 30-day threshold. Without the
        // `!bResumingDrain` guard the check fires on every continuation,
        // resets the cursor to 0, and the drain restarts from epoch forever —
        // the "Restoring sync state" infinite loop hit by any account whose
        // oldest unsynced entity/deletion is older than the stale threshold.
        // The transient drain cursor is NOT a "last successful sync" time;
        // only a FRESH cycle's cursor is, so only a fresh cycle may judge it
        // stale.
        const lastSyncTimestamp = SyncTransport.getLastSyncTimestamp();
        if (!bResumingDrain && lastSyncTimestamp > 0)
        {
            const timeSinceLastSync = Date.now() - lastSyncTimestamp;
            if (timeSinceLastSync > SyncOrchestrator.#STALE_THRESHOLD_MILLISECONDS)
            {
                console.warn("[SyncOrchestrator] Stale sync state — forcing full resync.");
                SyncTransport.setLastSyncTimestamp(0);
            }
        }

        // First sync or stale — gather every in-memory entity. Guarded on
        // !bResumingDrain so a drain continuation can never re-enter the
        // full-library gather (which would re-queue everything and feed the
        // re-push loop), even if serverTime ever came back as 0.
        const bFullLibraryPushCycle = !bResumingDrain && SyncTransport.getLastSyncTimestamp() === 0;
        if (bFullLibraryPushCycle)
        {
            const gatheredChanges = SyncApplier.gatherAllLocalEntities();
            for (const entityId of Object.keys(gatheredChanges))
            {
                SyncTransport.setPendingChange(entityId, gatheredChanges[entityId]);
            }
        }

        // NOTE: a timestamp-scan "reconciliation" pass was tried here to
        // rediscover offline edits the pending queue dropped, but it reused
        // gatherAllLocalEntities — whose orphan-detection emits DELETION
        // tombstones — on every cycle (that path is only safe during a
        // deliberate lastSync===0 full push). A deck that momentarily looked
        // orphaned in memory got deleted server-side, oscillating between
        // devices. Durability is instead handled without any delete logic by
        // persisting the pending queue on the offline-defer path in sync().

        // Drain continuations are pull-only: they push an empty changes array
        // (still one isLastChunk chunk, so the server runs the pull) instead
        // of re-pushing the pending snapshot. Re-pushing the residue every
        // continuation is what drove the runaway re-bump / re-pull loop. Any
        // local edit made mid-drain stays queued in pendingChanges and syncs
        // in the next fresh cycle after the drain completes.
        const changes = bResumingDrain ? [] : Object.values(SyncTransport.getPendingChanges());
        console.log(`[SyncOrchestrator] Pushing ${changes.length} changes to server${bResumingDrain ? " (drain continuation)" : ""}.`);

        // Drain continuations preserve the bar at wherever the previous
        // chunk's apply phase left it — anchoring overall progress in
        // entities, not phases. Only fresh syncs reset the bar to 0.
        if (!bResumingDrain)
        {
            SyncProgressReporter.setFraction(0);
        }

        const lockResponse = await SyncTransport.acquireLock();
        if (!lockResponse || !lockResponse.acquired)
        {
            console.warn("[SyncOrchestrator] Sync lock not acquired. Aborting.");
            SyncOrchestrator.#setState(syncStates.IDLE);
            window.dispatchEvent(new CustomEvent(SyncEvents.LOCK_BLOCKED));
            return;
        }

        if (!bResumingDrain)
        {
            SyncProgressReporter.setFraction(SyncOrchestrator.#PROGRESS_WEIGHT_LOCK);
        }

        try
        {
            const syncResponse = await SyncOrchestrator.#runPushPullPhase(changes, bResumingDrain);
            if (!syncResponse)
            {
                console.error("[SyncOrchestrator] Push/pull returned null — server unreachable.");
                SyncOrchestrator.#setState(syncStates.ERROR);
                window.dispatchEvent(new CustomEvent(SyncEvents.FAILED, { detail: { error: "No response from server." } }));
                SyncOrchestrator.#resetDrainState();
                return;
            }

            // Accumulate pulled-entity count for the run-wide empty-
            // state check at drain end. Includes this cycle's deletions
            // because a "deletion-only" pull is still meaningful data.
            const thisCyclePulled = (syncResponse.changes?.length || 0)
                                  + (syncResponse.deletions?.length || 0);
            SyncOrchestrator.#pulledEntityCountThisRun += thisCyclePulled;

            // ── Full-library resync: take the bulk snapshot, not the drain ──
            //
            // This cycle just pushed EVERY local entity (lastSync was 0 — a
            // first sync, a stale-cursor reset after a long absence, or a
            // wipe-recovery handshake) and the server answered "there is more
            // than one chunk of data to send back". Draining that through
            // /Sync costs one round trip per MAX_PULL_PER_COLLECTION entities,
            // each of which re-queries and re-serialises the account's whole
            // deck topology — the path a returning device used to crawl
            // through while the "X / Y items" total climbed.
            //
            // /Sync/BulkSnapshot streams the same data in ONE request and
            // commits it in a single IndexedDB transaction. It is safe here
            // for the same reason the fresh-client route is: the push above
            // already succeeded, so the server's copy is a superset of local
            // and the wholesale replace cannot lose anything. Both of
            // forcePullFromServer's bail-outs (pending changes appeared,
            // snapshot empty while local is not) still apply and fall back to
            // a normal cycle.
            //
            // #bBulkSnapshotResyncAttempted makes this one-shot per sync run:
            // if the bulk path bails, the retry it schedules lands back here
            // with the flag set and takes the ordinary chunked drain, so the
            // two paths can never hand work back and forth.
            if (bFullLibraryPushCycle
                && syncResponse.morePending === true
                && !SyncOrchestrator.#bBulkSnapshotResyncAttempted)
            {
                console.warn(`[SyncOrchestrator] Full-library push completed with ${syncResponse.remainingEntityCount ?? "?"} entities still pending — routing to the bulk snapshot instead of a multi-cycle drain.`);
                SyncOrchestrator.#bBulkSnapshotResyncAttempted = true;
                // The push landed, so drop the queue: leaving it populated
                // would trip forcePullFromServer's pending-changes bail and
                // send us straight back to the drain we are avoiding.
                SyncTransport.removePushedChanges(changes);
                await SyncTransport.saveSyncLog();
                SyncOrchestrator.#resetDrainState();
                // lastSync deliberately stays where it is — the bulk path sets
                // it from the snapshot's own ceiling. State stays SYNCING and
                // no COMPLETED is dispatched, so the blocking modal already on
                // screen carries straight over into the bulk pull.
                setTimeout(() => SyncOrchestrator.forcePullFromServer(), 0);
                return;
            }

            // Filter out the server's echoes of entities the user has
            // locally deleted while this cycle's push was in flight.
            // The pull always re-returns the just-pushed docs (their
            // serverUpdatedAt > the pre-cycle lastSync). Without this
            // guard, the apply phase's "no local entity → create one"
            // branch would resurrect a deck the user just trashed.
            // Deletions are pre-filtered against the SAME pending map,
            // not the snapshot, so they reflect any user actions taken
            // mid-push.
            const pendingChangesAfterPush = SyncTransport.getPendingChanges();
            const bHasLocalPendingDeletion = (entityId) =>
            {
                const pendingRecord = pendingChangesAfterPush[entityId];
                return pendingRecord !== undefined && pendingRecord.deleted === true;
            };

            const filteredServerChanges = (syncResponse.changes || []).filter((serverChange) =>
                !bHasLocalPendingDeletion(serverChange.entityId));
            const filteredServerDeletions = (syncResponse.deletions || []).filter((serverDeletion) =>
                !bHasLocalPendingDeletion(serverDeletion.entityId));
            const skippedEchoCount = (syncResponse.changes?.length || 0) - filteredServerChanges.length;
            if (skippedEchoCount > 0)
            {
                console.log(`[SyncOrchestrator] Skipped ${skippedEchoCount} server-echoed change(s) for locally-deleted entities.`);
            }

            const filteredSyncResponse =
            {
                ...syncResponse,
                changes:   filteredServerChanges,
                deletions: filteredServerDeletions,
            };

            await SyncOrchestrator.#runApplyPhase(filteredSyncResponse, bResumingDrain);

            // Wipe-recovery handshake: server detected it has no data
            // for this user but the client believed itself synced. Reset
            // the local cutoff to 0 and trigger one more cycle — the
            // zero-timestamp branch in #runSyncCycle() will call
            // SyncApplier.gatherAllLocalEntities() and push everything.
            if (syncResponse.requestFullResync === true)
            {
                console.warn("[SyncOrchestrator] Server requested full resync — local timestamp reset; re-running cycle to push every entity.");
                SyncTransport.setLastSyncTimestamp(0);
                SyncTransport.clearPendingChanges();
                await SyncTransport.saveSyncLog();
                SyncOrchestrator.#resetDrainState();
                SyncOrchestrator.#setState(syncStates.IDLE);
                // Defer the re-trigger to a fresh microtask so the
                // current cycle's lock release in `finally` runs first.
                setTimeout(() => SyncOrchestrator.sync(), 0);
                return;
            }

            SyncTransport.setLastSyncTimestamp(syncResponse.serverTime);
            // Stamp the client-clock anchor alongside the server cursor so the
            // reconciliation scan (above, next cycle) has a skew-immune "since"
            // to compare entity lifecycle.lastModified against.
            SyncTransport.setLastSyncLocalMillis(Date.now());
            // Reference-aware removal: clear only the entries that were
            // actually pushed AND have not been superseded by a newer
            // record (typically a delete that arrived mid-push). The
            // surviving records get pushed in the next cycle so the
            // server eventually reflects the user's most recent intent.
            SyncTransport.removePushedChanges(changes);

            await SyncTransport.saveSyncLog();

            // Multi-chunk drain handshake: only the FINAL chunk fires
            // COMPLETED and surfaces the "Synced" status. Intermediate
            // chunks just schedule the next cycle, leaving the bar +
            // spinner exactly where they are so the user never sees the
            // "Synced ✓" → "Syncing 0%" flicker.
            if (syncResponse.morePending === true)
            {
                console.log(`[SyncOrchestrator] morePending — ${SyncOrchestrator.#processedDrainEntities}/${SyncOrchestrator.#totalDrainEntities} entities so far; re-running sync to drain the next chunk.`);
                setTimeout(() => SyncOrchestrator.sync({ bForce: true }), 0);
            }
            else
            {
                // Empty-state safety net. We classify the just-finished
                // drain BEFORE resetting state because #resetDrainState
                // zeroes the run-wide pulled count.
                const bDrainPulledNothing = SyncOrchestrator.#pulledEntityCountThisRun === 0;
                const bClientIsEmpty      = SyncOrchestrator.#isLocalLibraryEffectivelyEmpty();
                const bAlreadyAutoRetried = SyncOrchestrator.#bAutoForcePullAttempted;

                // A drain that ran to completion is proof the chunked path
                // works for this account, so re-arm the bulk-snapshot reroute
                // for the next full-library push.
                SyncOrchestrator.#bBulkSnapshotResyncAttempted = false;

                SyncOrchestrator.#resetDrainState();
                SyncOrchestrator.#setState(syncStates.IDLE);
                window.dispatchEvent(new CustomEvent(SyncEvents.COMPLETED));

                if (bDrainPulledNothing && bClientIsEmpty)
                {
                    if (!bAlreadyAutoRetried)
                    {
                        // First time both came back empty in this
                        // session — re-run sync from epoch in case a
                        // corrupted lastSync was hiding real data. We
                        // set the flag BEFORE scheduling so a re-entry
                        // through this same branch (the retry also
                        // coming back empty) hits the else path below.
                        SyncOrchestrator.#bAutoForcePullAttempted = true;
                        console.warn("[SyncOrchestrator] Drain completed empty with an empty local library — auto-retrying once with lastSync = 0.");
                        setTimeout(() => SyncOrchestrator.forcePullFromServer(), 0);
                    }
                    else
                    {
                        // Auto-retry already happened earlier in this
                        // session and we're STILL empty. Surface the
                        // Force Pull button so the user can keep
                        // retrying manually if they think the server
                        // should have data — but stop spinning.
                        console.warn("[SyncOrchestrator] Auto Force Pull already attempted; surfacing Force Pull button.");
                        window.dispatchEvent(new CustomEvent(SyncEvents.NO_DATA_AFTER_SYNC));
                    }
                }
                else
                {
                    // Either we pulled real data this drain or the
                    // local library is non-empty. Either way the system
                    // is in a healthy state — clear the one-shot guard
                    // so any future emptiness gets its own auto-retry.
                    SyncOrchestrator.#bAutoForcePullAttempted = false;
                }
            }
        }
        finally
        {
            await SyncTransport.releaseLock();
        }
    }

    /**
     * Records every entity in a pull response against the drain's seen-set and
     * returns how many of them were genuinely new.
     *
     * Keyed by entityType + entityId because ids are only unique within a
     * collection, and because a deletion tombstone for an entity whose upsert
     * arrived earlier in the same drain is NOT new work to count twice.
     */
    static #registerDrainEntities(serverChanges, serverDeletions)
    {
        let newEntityCount = 0;

        const registerEntity = (entityType, entityId) =>
        {
            if (entityId === undefined || entityId === null)
            {
                return;
            }
            const entityKey = `${entityType}:${entityId}`;
            if (SyncOrchestrator.#drainProcessedEntityKeys.has(entityKey))
            {
                return;
            }
            SyncOrchestrator.#drainProcessedEntityKeys.add(entityKey);
            newEntityCount++;
        };

        for (let changeIndex = 0; changeIndex < serverChanges.length; changeIndex++)
        {
            registerEntity(serverChanges[changeIndex].entityType, serverChanges[changeIndex].entityId);
        }

        for (let deletionIndex = 0; deletionIndex < serverDeletions.length; deletionIndex++)
        {
            registerEntity(serverDeletions[deletionIndex].entityType, serverDeletions[deletionIndex].entityId);
        }

        return newEntityCount;
    }

    static #resetDrainState()
    {
        SyncOrchestrator.#bInChunkedDrain        = false;
        SyncOrchestrator.#processedDrainEntities = 0;
        SyncOrchestrator.#totalDrainEntities     = 0;
        SyncOrchestrator.#pulledEntityCountThisRun = 0;
        SyncOrchestrator.#drainProcessedEntityKeys.clear();
        // Any deck the applier parked waiting for a parent belonged to the
        // drain we are tearing down; without this it would survive into an
        // unrelated later cycle and be judged against a tree it never
        // came from.
        SyncApplier.clearDeferredOrphanDecks();
    }

    /**
     * Mounts a SyncBlockingDialog if none is currently active. Idempotent
     * — re-entry from the multi-cycle drain path hits this guard and is
     * a no-op, so the dialog persists across drain cycles without
     * stacking. Dismount is event-driven (see the COMPLETED / FAILED
     * listeners in the static initialiser).
     */
    static #ensureBlockingDialog(title)
    {
        if (SyncOrchestrator.#activeBlockingDialog !== null)
        {
            return;
        }
        SyncOrchestrator.#activeBlockingDialog = SyncBlockingDialog.show(title);
    }

    /**
     * Returns true when the only deck in memory is the locally-created
     * root and it carries no cards, study materials or mock tests. This
     * is the "fresh client with nothing pulled" shape — used to decide
     * whether to fire NO_DATA_AFTER_SYNC at the end of a drain.
     */
    static #isLocalLibraryEffectivelyEmpty()
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            return true;
        }

        const allDecks = typeof Deck.getAll === "function" ? Deck.getAll() : [];
        if (allDecks.length > 1)
        {
            return false;
        }

        const cards = typeof rootDeck.getCards === "function" ? rootDeck.getCards(true, true) : [];
        if (cards.length > 0)
        {
            return false;
        }

        const studyMaterials = typeof rootDeck.getStudyMaterials === "function" ? rootDeck.getStudyMaterials(true, true) : [];
        if (studyMaterials.length > 0)
        {
            return false;
        }

        const mockTests = typeof rootDeck.getMockTests === "function" ? rootDeck.getMockTests(true) : [];
        if (mockTests.length > 0)
        {
            return false;
        }

        return true;
    }

    /**
     * Escape hatch for the "Synced but empty" case — invoked both
     * automatically (one-shot after the first empty drain) and via the
     * Force Pull button. Uses the bulk-snapshot endpoint to download
     * every entity in ONE HTTP request, reconstructs the deck tree
     * in memory, and commits the lot in a SINGLE IndexedDB transaction.
     * Much faster than a chunked drain whose per-deck IDB saves
     * dominate the wall-clock time.
     */
    static async forcePullFromServer(options = {})
    {
        // Same legal-acceptance gate as sync() — this path also mounts a
        // non-dismissible blocking modal, so it must never run while the
        // legal modal is still pending.
        await TermsAndConditionsManager.whenLegalSettled();

        const bDiscardPendingChanges = options.bDiscardPendingChanges === true;

        console.warn(`[SyncOrchestrator] forcePullFromServer invoked — downloading bulk snapshot. (discardPending=${bDiscardPendingChanges})`);

        const releaseMutex = await SyncOrchestrator.#syncMutex.acquire();

        // Active-entity guard. The bulk-snapshot apply phase below calls
        // Deck.clearAllInMemory() which wipes every Card / StudyMaterial /
        // MockTest reference. Any page currently rendering the active
        // entity (Study session, card editor, etc.) is holding object
        // references that go stale the moment the wipe runs — its next
        // tick reads getDeck() / getCards() against a freshly constructed
        // tree that doesn't know about its in-progress edit, and a
        // `save()` on the held reference crashes inside Card.save /
        // StudyMaterial.save when getDeck() returns null. Navigate back
        // to the home page first so PageNavigator's own teardown clears
        // the active-entity tracker and removes the stale render;
        // `clearAndOpen` wipes the page stack so the user can't /back/
        // into the now-orphaned page either.
        //
        // We do this AFTER acquiring the mutex so any sync cycle that
        // was mid-apply when force-pull was triggered has fully
        // completed first — otherwise the home page would re-render
        // against a tree the apply phase is still mutating.
        if (ActiveEntityTracker.getId())
        {
            console.warn(`[SyncOrchestrator] forcePullFromServer — active entity ${ActiveEntityTracker.getId()} is set; navigating to home before wiping in-memory state.`);
            PageNavigator.clearAndOpen("home-page");
            ActiveEntityTracker.clear();
        }

        // Callers that know they've just invalidated the server's view of
        // the world (e.g. the Clear All Server Data flow) pass
        // bDiscardPendingChanges so the safeguard below doesn't bail —
        // any pending local changes reference data that no longer exists
        // on the server and would just re-upload stale state if pushed.
        if (bDiscardPendingChanges && SyncTransport.getPendingChangeCount() > 0)
        {
            console.warn(`[SyncOrchestrator] forcePullFromServer — discarding ${SyncTransport.getPendingChangeCount()} pending local change(s) at caller's request before bulk replace.`);
            SyncTransport.clearPendingChanges();
            SyncTransport.setLastSyncTimestamp(0);
            await SyncTransport.saveSyncLog();
        }

        // Block all user interaction with a non-dismissible modal while
        // the bulk snapshot is in flight + applying. The modal's
        // progress bar + label are driven by SyncEvents listeners
        // mounted in the static initialiser, so the body of this method
        // doesn't need to manage them directly.
        SyncOrchestrator.#ensureBlockingDialog(SyncOrchestrator.#FORCE_PULL_MODAL_TITLE);

        SyncOrchestrator.#setState(syncStates.SYNCING);
        window.dispatchEvent(new CustomEvent(SyncEvents.STARTED));
        SyncProgressReporter.setFraction(0.02);

        try
        {
            // 1. Download. The endpoint streams NDJSON; SyncTransport
            // parses line-by-line and fires `onProgress(processed, total)`
            // both when the header (with counts) arrives and at regular
            // intervals thereafter. We rebroadcast that as
            // ENTITY_PROGRESS so the UI can show "X / Y entities", and
            // drive the download segment of the bar by entity progress
            // rather than letting it sit at 0.02 for the whole pull.
            const snapshot = await SyncTransport.fetchBulkSnapshot((processedCount, totalCount) =>
            {
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_PROGRESS,
                {
                    detail: { processed: processedCount, total: totalCount, phase: "download" }
                }));

                if (totalCount > 0)
                {
                    // Map download progress into the 0.05..0.55 band so
                    // the apply phase still has runway for its own
                    // animation. `setFraction` is forward-only via the
                    // progress reporter's internal clamp.
                    const downloadFraction = 0.05 + (processedCount / totalCount) * 0.50;
                    if (downloadFraction > SyncProgressReporter.getFraction())
                    {
                        SyncProgressReporter.setFraction(Math.min(0.55, downloadFraction));
                    }
                }
            });
            if (!snapshot)
            {
                throw new Error("Bulk snapshot fetch returned null (server unreachable or error).");
            }

            // Race-condition safeguard: while we were waiting on the network
            // for the snapshot, the user may have made local changes — most
            // commonly importing a deck on a fresh login. applyBulkSnapshot
            // would call Deck.clearAllInMemory() and clearPendingChanges()
            // below would erase the record, so the import would silently
            // vanish on the very first sync. Bail out and route to a normal
            // sync cycle that pushes the local changes up first; the next
            // pull reconciles whatever the server has.
            if (SyncTransport.getPendingChangeCount() > 0)
            {
                console.warn(`[SyncOrchestrator] forcePullFromServer bailing after snapshot fetch — ${SyncTransport.getPendingChangeCount()} pending local change(s) appeared during the in-flight fetch. Routing to normal sync cycle to preserve them.`);
                SyncOrchestrator.#setState(syncStates.IDLE);
                window.dispatchEvent(new CustomEvent(SyncEvents.COMPLETED));
                releaseMutex();
                await SyncOrchestrator.sync({ bForce: true });
                return;
            }

            // Empty-snapshot data-loss safeguard. The apply phase below
            // calls Deck.clearAllInMemory(). If the server returned an
            // effectively-empty snapshot (no real entities) while the
            // local library DOES hold real data, replacing local with the
            // empty snapshot would silently destroy the user's decks. This
            // is the reported "deck imported on another device briefly
            // appears on a fresh/slow login, then vanishes" failure: the
            // local tree was populated (from disk or a partial pull) but
            // the server's view hadn't caught up yet. Preserve local and
            // route to a normal sync cycle that pushes it up first; the
            // next pull reconciles against whatever the server then has.
            //
            // Deliberate wipes (Clear All Server Data) pass
            // bDiscardPendingChanges and are exempt. The fresh-client,
            // auto-retry, and "Force Pull" button paths only run with an
            // empty local library, so this guard is inert for them.
            const incomingDeckCount          = Array.isArray(snapshot.decks)          ? snapshot.decks.length          : 0;
            const incomingCardCount          = Array.isArray(snapshot.cards)          ? snapshot.cards.length          : 0;
            const incomingStudyMaterialCount = Array.isArray(snapshot.studyMaterials) ? snapshot.studyMaterials.length : 0;
            const incomingMockTestCount      = Array.isArray(snapshot.mockTests)      ? snapshot.mockTests.length      : 0;
            const bSnapshotEffectivelyEmpty  = incomingDeckCount <= 1
                && incomingCardCount === 0
                && incomingStudyMaterialCount === 0
                && incomingMockTestCount === 0;

            if (!bDiscardPendingChanges
                && bSnapshotEffectivelyEmpty
                && !SyncOrchestrator.#isLocalLibraryEffectivelyEmpty())
            {
                console.warn("[SyncOrchestrator] forcePullFromServer aborting bulk replace — the server snapshot is empty but the local library holds real data. Preserving local and routing to a normal sync cycle to push it up first.");
                SyncOrchestrator.#setState(syncStates.IDLE);
                window.dispatchEvent(new CustomEvent(SyncEvents.COMPLETED));
                releaseMutex();
                await SyncOrchestrator.sync({ bForce: true });
                return;
            }

            SyncProgressReporter.setFraction(0.55);

            // 2. Replace in-memory tree + commit to IDB in one bulk
            // transaction. This is where ~95% of the wall-clock
            // savings vs the chunked drain come from.
            const applyResult = await SyncApplier.applyBulkSnapshot(snapshot);
            SyncProgressReporter.setFraction(0.92);

            // 3. Reset sync log: lastSync = serverTime, no pending
            // changes (the local tree is now an exact mirror of the
            // server's view).
            const newLastSync = typeof snapshot.serverTime === "number" ? snapshot.serverTime : Date.now();
            SyncTransport.setLastSyncTimestamp(newLastSync);
            // The local tree now exactly mirrors the server, so anchor the
            // reconciliation cutoff at "now" — every pulled entity's
            // lastModified predates this, so nothing is spuriously re-pushed.
            SyncTransport.setLastSyncLocalMillis(Date.now());
            SyncTransport.clearPendingChanges();
            await SyncTransport.saveSyncLog();
            SyncProgressReporter.setFraction(1.0);

            // 4. Clear drain / auto-retry guards. The system is healthy
            // — any future empty-state can fire a fresh one-shot retry.
            SyncOrchestrator.#bAutoForcePullAttempted = false;
            SyncOrchestrator.#bBulkSnapshotResyncAttempted = false;
            SyncOrchestrator.#resetDrainState();

            // 5. Republish the deck tree so every page listening for
            // DeckEvents.CREATE re-renders against the new root.
            const rootDeck = Deck.getRoot();
            if (rootDeck)
            {
                window.dispatchEvent(new CustomEvent(DeckEvents.CREATE, { detail: { deck: rootDeck } }));
                window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: rootDeck } }));
            }

            SyncOrchestrator.#setState(syncStates.IDLE);
            window.dispatchEvent(new CustomEvent(SyncEvents.COMPLETED));

            console.log(`[SyncOrchestrator] forcePullFromServer complete — ${applyResult.decks} decks, ${applyResult.cards} cards, ${applyResult.studyMaterials} study materials, ${applyResult.mockTests} mock tests.`);
        }
        catch (bulkPullError)
        {
            console.error("[SyncOrchestrator] forcePullFromServer failed:", bulkPullError);
            SyncOrchestrator.#setState(syncStates.ERROR);
            window.dispatchEvent(new CustomEvent(SyncEvents.FAILED, { detail: { error: bulkPullError } }));
        }
        finally
        {
            SyncProgressReporter.stopAnimation();
            releaseMutex();
        }
    }

    /**
     * Pushes pendingChanges to the server (chunked) while the progress
     * bar runs an asymptotic animation toward the end of the push phase.
     * Returns the response from the final chunk (server changes +
     * deletions + serverTime).
     */
    static async #runPushPullPhase(changes, bResumingDrain = false)
    {
        // Drain continuations have nothing to push (pendingChanges was
        // cleared in the previous cycle). Crawl gently into a tiny
        // overshoot of the current bar position while the server-side
        // pull is in flight, then hand off to the apply phase.
        if (bResumingDrain)
        {
            const currentFraction = SyncProgressReporter.getFraction();
            const drainCrawlEnd   = Math.min(
                SyncOrchestrator.#DRAIN_PROGRESS_CAP,
                currentFraction + 0.04
            );
            SyncProgressReporter.animateAsymptoticTo(drainCrawlEnd, SyncOrchestrator.#PUSH_ANIMATION_EXPECTED_MS);

            const drainResponse = await SyncTransport.pushInChunks(changes);

            SyncProgressReporter.stopAnimation();
            return drainResponse;
        }

        const pushPhaseStart      = SyncProgressReporter.getFraction();
        const pushPhaseEnd        = pushPhaseStart + SyncOrchestrator.#PROGRESS_WEIGHT_PUSH;
        // No pending changes → keep the bar low; the apply phase will
        // glide forward from wherever this leaves us. With actual
        // changes to push, overshoot into apply territory so the bar
        // visibly creeps during the server-side pull's latency.
        const visualAsymptoteEnd  = changes.length === 0
            ? Math.min(0.30, pushPhaseEnd)
            : Math.min(0.95, pushPhaseEnd + SyncOrchestrator.#PUSH_VISUAL_OVERSHOOT);
        const totalChunks         = Math.max(1, Math.ceil(changes.length / SyncTransport.getChunkSize()));

        let chunksCompleted = 0;
        const onChunkComplete = () =>
        {
            chunksCompleted++;
            const anchor = pushPhaseStart + (pushPhaseEnd - pushPhaseStart) * (chunksCompleted / totalChunks);
            // Forward-only: never undo whatever the asymptotic crawl has
            // already advanced through during a long server-pull wait.
            if (anchor > SyncProgressReporter.getFraction())
            {
                SyncProgressReporter.setFraction(anchor);
            }
            if (chunksCompleted < totalChunks)
            {
                SyncProgressReporter.animateAsymptoticTo(visualAsymptoteEnd, SyncOrchestrator.#PUSH_ANIMATION_EXPECTED_MS);
            }

            // Surface push-side entity counts so the force-push modal
            // (and the status label) can render "X / Y items…" while
            // a large local library is uploading.
            if (changes.length > 0)
            {
                const pushedSoFar = Math.min(changes.length, chunksCompleted * SyncTransport.getChunkSize());
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_PROGRESS,
                {
                    detail: { processed: pushedSoFar, total: changes.length, phase: "push" }
                }));
            }
        };

        SyncProgressReporter.animateAsymptoticTo(visualAsymptoteEnd, SyncOrchestrator.#PUSH_ANIMATION_EXPECTED_MS);

        const syncResponse = await SyncTransport.pushInChunks(changes, onChunkComplete);

        SyncProgressReporter.stopAnimation();
        // Don't animate backwards: if the crawl is already past
        // pushPhaseEnd, leave it there and let the tail glide pick up
        // from wherever the bar landed.

        return syncResponse;
    }

    /**
     * Applies server-returned changes and deletions, flushes any dirty
     * decks, and advances the progress bar across all three sub-phases.
     * If the response is empty for both changes and deletions, the
     * progress bar glides smoothly to 1.0 instead of jumping through
     * four phase-end snaps back-to-back.
     */
    static async #runApplyPhase(syncResponse, bResumingDrain = false)
    {
        const serverChanges     = syncResponse.changes   || [];
        const serverDeletions   = syncResponse.deletions || [];
        const bResponseChunked  = syncResponse.morePending === true;
        // Raw payload size — drives the glide animation, because that is the
        // work this cycle actually performs (re-applying a re-delivered deck
        // still costs a comparison).
        const thisChunkEntities = serverChanges.length + serverDeletions.length;
        // Distinct entities this drain had not seen before — drives every
        // progress NUMBER, so re-delivery cannot inflate the counters.
        const newEntityCount    = SyncOrchestrator.#registerDrainEntities(serverChanges, serverDeletions);
        const remainingEntities = typeof syncResponse.remainingEntityCount === "number"
            ? syncResponse.remainingEntityCount
            : 0;

        SyncOrchestrator.#bApplyingServerChanges = true;

        // Raise the active-entity overlay for any pull that touches the
        // entity the user is currently EDITING — not just chunked drains,
        // but also NOT mere read-only study / viewing sessions. A
        // single-entity pull whose `data.lifecycle.lastModified` is newer
        // than the local copy will overwrite the in-memory
        // Card / StudyMaterial / MockTest object reference held by the
        // editor page — and the editor's subsequent `save()` then writes
        // the user's pre-pull edits back over the server's newer state,
        // leaving both the editor and the server stuck on a stale value
        // with no visible warning. Blocking that pull is cheap (the
        // overlay only stays up for the apply phase, typically a few
        // hundred ms) and keeps the editor's reference stable until the
        // user dismisses it. When the same entity is only being studied
        // (ActiveEntityTracker.isEditing() === false) there are no
        // in-flight edits to clobber, so we let the pull apply silently
        // rather than interrupt the study session with a modal. The
        // whole-DB bulk-snapshot path (`forcePullFromServer`) uses its
        // own SyncBlockingDialog so it doesn't rely on this event.
        const bBlockingActiveEntity   = ActiveEntityTracker.isEditing()
            && SyncApplier.isActiveEntityAffected(serverChanges, serverDeletions);
        const blockedActiveEntityId   = bBlockingActiveEntity ? ActiveEntityTracker.getId()   : null;
        const blockedActiveEntityType = bBlockingActiveEntity ? ActiveEntityTracker.getType() : null;

        if (bBlockingActiveEntity)
        {
            window.dispatchEvent(new CustomEvent(SyncEvents.ACTIVE_ENTITY_SYNC_STARTED,
            {
                detail: { entityId: blockedActiveEntityId, entityType: blockedActiveEntityType },
            }));
        }

        try
        {
            const dirtyDeckIds = new Set();

            // Resolve the glide target for this cycle's apply:
            //  • Drain cycle (morePending=true): entity-based — bar
            //    advances by this chunk's share of the total drain.
            //  • Final cycle of a drain (morePending=false but we were
            //    in a drain): march straight to 1.0 over a scaled glide.
            //  • Non-drain cycle: existing HOLD_FRACTION glide, snapped
            //    to 1.0 after apply finishes.
            let glideTarget;
            let bFinalisingDrain = false;
            const currentFraction = SyncProgressReporter.getFraction();

            if (bResponseChunked)
            {
                // Refresh the total estimate every cycle so we self-
                // correct if entities are added on the server mid-drain.
                SyncOrchestrator.#totalDrainEntities =
                    SyncOrchestrator.#processedDrainEntities + newEntityCount + remainingEntities;
                SyncOrchestrator.#bInChunkedDrain = true;

                // Surface entity counts as soon as we know the total so
                // the UI can swap the opaque percentage for "X / Y".
                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_PROGRESS,
                {
                    detail:
                    {
                        processed: SyncOrchestrator.#processedDrainEntities,
                        total:     SyncOrchestrator.#totalDrainEntities,
                        phase:     "apply",
                    }
                }));

                const projectedProcessed = SyncOrchestrator.#processedDrainEntities + newEntityCount;
                const denominator        = Math.max(1, SyncOrchestrator.#totalDrainEntities);
                const entityBasedFraction = (projectedProcessed / denominator) * SyncOrchestrator.#DRAIN_PROGRESS_CAP;

                // Never go backwards mid-drain.
                glideTarget = Math.max(currentFraction, entityBasedFraction);
            }
            else if (bResumingDrain || SyncOrchestrator.#bInChunkedDrain)
            {
                bFinalisingDrain = true;
                glideTarget      = SyncOrchestrator.#TAIL_GLIDE_HOLD_FRACTION;
            }
            else
            {
                glideTarget = SyncOrchestrator.#TAIL_GLIDE_HOLD_FRACTION;
            }

            // Scale glide duration to the actual workload so small
            // chunked responses don't whiplash and large pulls don't
            // claim "done" while apply is still rebuilding decks.
            const scaledGlideMs = thisChunkEntities * SyncOrchestrator.#TAIL_GLIDE_MS_PER_ENTITY;
            const clampedGlideMs = Math.max(
                bResponseChunked ? SyncOrchestrator.#DRAIN_CYCLE_MIN_GLIDE_MS : SyncOrchestrator.#TAIL_GLIDE_MIN_MS,
                Math.min(SyncOrchestrator.#TAIL_GLIDE_MAX_MS, scaledGlideMs)
            );
            const tailGlideMs = thisChunkEntities === 0
                ? SyncOrchestrator.#TRIVIAL_TAIL_ANIMATION_MS
                : clampedGlideMs;

            const tailAnimationPromise = SyncProgressReporter.animateLinearTo(glideTarget, tailGlideMs);

            // While the drain still has chunks pending, a deck whose parent has
            // not arrived is "not delivered yet", not an orphan — the applier
            // parks it for the next cycle instead of tombstoning it (which the
            // server-side cascade would turn into a real deletion of the deck
            // and everything under it).
            await SyncApplier.applyServerChanges(serverChanges, dirtyDeckIds, null, bResponseChunked);
            await SyncApplier.applyServerDeletions(serverDeletions, dirtyDeckIds);
            await SyncApplier.flushDirtyDecks(dirtyDeckIds);
            await tailAnimationPromise;

            if (bResponseChunked)
            {
                SyncOrchestrator.#processedDrainEntities += newEntityCount;

                window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_PROGRESS,
                {
                    detail:
                    {
                        processed: SyncOrchestrator.#processedDrainEntities,
                        total:     SyncOrchestrator.#totalDrainEntities,
                        phase:     "apply",
                    }
                }));
            }
            else
            {
                // Final/non-drain apply — settle the bar at 1.0. If we
                // were finalising a drain, push one last ENTITY_PROGRESS
                // pinned to the total so the count display lands cleanly
                // on "X / X" instead of stopping at "X / Y" with X<Y.
                if (bFinalisingDrain && SyncOrchestrator.#totalDrainEntities > 0)
                {
                    const finalProcessed = SyncOrchestrator.#processedDrainEntities + newEntityCount;
                    const finalTotal     = Math.max(finalProcessed, SyncOrchestrator.#totalDrainEntities);
                    window.dispatchEvent(new CustomEvent(SyncEvents.ENTITY_PROGRESS,
                    {
                        detail: { processed: finalTotal, total: finalTotal, phase: "apply" }
                    }));
                }

                await SyncProgressReporter.animateLinearTo(1.0, SyncOrchestrator.#PHASE_TRANSITION_MS);
            }
        }
        finally
        {
            SyncOrchestrator.#bApplyingServerChanges = false;

            if (bBlockingActiveEntity)
            {
                window.dispatchEvent(new CustomEvent(SyncEvents.ACTIVE_ENTITY_SYNC_ENDED,
                {
                    detail: { entityId: blockedActiveEntityId, entityType: blockedActiveEntityType },
                }));
            }
        }

        // Refresh the UI if any changes were applied — navigate up if the
        // current deck was deleted remotely.
        if (serverChanges.length > 0 || serverDeletions.length > 0)
        {
            let currentDeck = Deck.getCurrentDeck();
            while (currentDeck && !Deck.getById(currentDeck.getId()))
            {
                console.warn(`[SyncOrchestrator] Current deck "${currentDeck.getName()}" deleted remotely. Navigating up.`);
                currentDeck = currentDeck.getParent();
            }

            const targetDeck = currentDeck || Deck.getRoot();
            Deck.setCurrentDeck(targetDeck);
            window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: targetDeck } }));
        }
    }
}

export default SyncOrchestrator;
