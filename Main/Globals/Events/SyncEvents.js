class SyncEvents
{
    static ENTITY_CHANGED = "sync-entity-changed";
    static ENTITY_DELETED = "sync-entity-deleted";
    static STARTED = "sync-started";
    static COMPLETED = "sync-completed";
    static FAILED = "sync-failed";
    static STATE_CHANGED = "sync-state-changed";

    // Dispatched as each push chunk completes (plus once for the apply phase).
    // Carries { completed, total } in detail — derived from the chunk count, so
    // it incurs no extra network calls.
    static PROGRESS = "sync-progress";

    // Dispatched when sync code knows the running count of entities it's
    // pulling/applying and the total it expects. Carries
    // { processed, total, phase } in detail, where phase is one of
    // "download" (bulk snapshot path), "apply" (chunked drain) etc.
    // The status UI uses this to render "Syncing X / Y" alongside the
    // raw percentage bar, which is opaque on its own for large pulls.
    // ENTITY_PROGRESS owns the status label when active; the
    // percentage-only PROGRESS event yields to it.
    static ENTITY_PROGRESS = "sync-entity-progress";

    // Dispatched when an incoming pull is about to mutate the entity the user
    // is currently engaged with. Carries { entityId, entityType } in detail.
    static ACTIVE_ENTITY_SYNC_STARTED = "sync-active-entity-started";

    // Dispatched once that mutation (and its disk flush) has completed.
    // Carries { entityId, entityType } in detail.
    static ACTIVE_ENTITY_SYNC_ENDED = "sync-active-entity-ended";

    // Dispatched when the automatic sync scheduler decides to skip a sync
    // because connectivity looks poor (offline, slow-2g/2g). Carries
    // { reason: "offline" | "slow" } in detail. The UI should surface a
    // "tap to sync" affordance — the user can still trigger a manual sync,
    // which bypasses this guard.
    static DEFERRED = "sync-deferred";

    // Dispatched when /Sync/Lock returned acquired:false — another device
    // (or a leaked TTL from a crashed cycle) is holding the server-side
    // sync lock for this user. The UI should surface a "Force" affordance
    // that POSTs /Sync/ForceUnlock and re-triggers sync.
    static LOCK_BLOCKED = "sync-lock-blocked";

    // Dispatched at the end of a successful sync when BOTH the local
    // entity count AND the entities pulled this drain are zero — i.e.
    // the user's library still looks empty after a "Synced" completion.
    // Typical on a fresh login when the cluster has nothing under their
    // userId, but also a safety hatch when a corrupted lastSync makes
    // the cutoff skip all docs. The UI surfaces a "Force Pull" button
    // that resets lastSync to 0 and re-syncs, giving the user one
    // explicit retry rather than silently leaving them at an empty home.
    static NO_DATA_AFTER_SYNC = "sync-no-data-after-sync";
}

export default SyncEvents;