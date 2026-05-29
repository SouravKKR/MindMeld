import SyncOrchestrator from "./Syncing/SyncOrchestrator.js";


/**
 * SyncManager
 *
 * Thin façade preserving the public API the rest of the app calls into:
 *   - SyncManager.sync(options)
 *   - SyncManager.getState()
 *   - SyncManager.getDeviceId()
 *   - SyncManager.shutdown()
 *
 * All real work lives under Globals/Classes/Syncing/:
 *   - SyncOrchestrator       — lifecycle, state machine, main sync() loop
 *   - SyncTransport          — device id, sync log, push chunking, lock/unlock
 *   - SyncApplier            — applying server changes/deletions + flush
 *   - SyncProgressReporter   — 0..1 progress fraction + animations
 *
 * Importing this file also triggers SyncOrchestrator's static initialiser,
 * which registers the lifecycle event listeners — same boot behaviour as
 * the original monolithic class.
 */
class SyncManager
{
    static async sync(options = {})
    {
        return await SyncOrchestrator.sync(options);
    }

    static getState()
    {
        return SyncOrchestrator.getState();
    }

    static getDeviceId()
    {
        return SyncOrchestrator.getDeviceId();
    }

    static async shutdown()
    {
        return await SyncOrchestrator.shutdown();
    }

    static async forceUnlockAndResync()
    {
        return await SyncOrchestrator.forceUnlockAndResync();
    }

    static async forcePullFromServer(options = {})
    {
        return await SyncOrchestrator.forcePullFromServer(options);
    }
}

export default SyncManager;
