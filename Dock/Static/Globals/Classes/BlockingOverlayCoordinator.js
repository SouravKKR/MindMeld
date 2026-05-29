/**
 * BlockingOverlayCoordinator
 *
 * Serializes full-screen, non-dismissable overlays so the user never
 * sees two of them stacked on top of each other (or worse — one
 * trapped behind another, intercepting clicks the user can't reach).
 *
 * Three legacy callers each used to manage their own mount lifecycle
 * with no awareness of the others:
 *   - InitializationOverlay (boot-time data load)
 *   - SyncBlockingDialog    (force-pull / first-sync / blocking sync states)
 *   - TutorialOverlay       (first-launch guided tour)
 *
 * On a fresh device launch all three could fire within a few hundred
 * milliseconds of each other, producing the "dialogs stacked behind
 * one another" symptom the user reported.
 *
 * Contract:
 *   - `request(id)` returns a promise that resolves when the caller
 *     has exclusive presentation rights. Mount the overlay AFTER the
 *     promise resolves.
 *   - `release(id)` MUST be called when the overlay is dismissed (the
 *     hide / unmount path), otherwise downstream waiters hang forever.
 *   - FIFO order — the first caller to `request` after the active
 *     owner releases is the next presenter. There are only three known
 *     callers and they always arrive in the natural order
 *     init -> sync -> tutorial, so a priority lane isn't worth the
 *     complexity.
 *   - `markActive(id)` is the synchronous variant for the
 *     InitializationOverlay, which is hard-mounted at boot via
 *     index.html — it doesn't have an `await` site before mounting.
 *     Calling it makes the overlay the active owner if the slot is
 *     free; if something else is already active it is a no-op (we
 *     trust the natural boot order to put init first).
 */
class BlockingOverlayCoordinator
{
    static #activeOwnerId = null;
    static #waiters = [];

    /**
     * Synchronously claims the presentation slot if it's free.
     * Returns true if the caller is now the active owner, false if
     * another overlay is already showing. Used by overlays that mount
     * eagerly and can't await.
     *
     * @param {string} ownerId
     * @returns {boolean}
     */
    static markActive(ownerId)
    {
        if (BlockingOverlayCoordinator.#activeOwnerId === null)
        {
            BlockingOverlayCoordinator.#activeOwnerId = ownerId;
            return true;
        }
        if (BlockingOverlayCoordinator.#activeOwnerId === ownerId)
        {
            return true;
        }
        return false;
    }

    /**
     * Async wait for the slot. Resolves immediately if free, otherwise
     * enqueues FIFO and resolves when prior owners release.
     *
     * @param {string} ownerId
     * @returns {Promise<void>}
     */
    static request(ownerId)
    {
        if (BlockingOverlayCoordinator.#activeOwnerId === null)
        {
            BlockingOverlayCoordinator.#activeOwnerId = ownerId;
            return Promise.resolve();
        }
        if (BlockingOverlayCoordinator.#activeOwnerId === ownerId)
        {
            return Promise.resolve();
        }
        return new Promise((resolveWait) =>
        {
            BlockingOverlayCoordinator.#waiters.push({ ownerId, resolveWait });
        });
    }

    /**
     * Releases the slot. If the releasing id is the active owner, the
     * next FIFO waiter is granted the slot. If the releasing id is
     * still in the waiter queue (caller withdrew before its turn), it
     * is silently removed.
     *
     * @param {string} ownerId
     */
    static release(ownerId)
    {
        if (BlockingOverlayCoordinator.#activeOwnerId === ownerId)
        {
            BlockingOverlayCoordinator.#activeOwnerId = null;
            BlockingOverlayCoordinator.#advance();
            return;
        }

        const remainingWaiters = [];
        for (const waiter of BlockingOverlayCoordinator.#waiters)
        {
            if (waiter.ownerId !== ownerId)
            {
                remainingWaiters.push(waiter);
            }
        }
        BlockingOverlayCoordinator.#waiters = remainingWaiters;
    }

    /**
     * Read-only — true when some overlay holds the slot. Useful for
     * components that want to defer non-essential UI work (e.g. open a
     * tooltip) while a blocking overlay is up.
     *
     * @returns {boolean}
     */
    static isBusy()
    {
        return BlockingOverlayCoordinator.#activeOwnerId !== null;
    }

    static #advance()
    {
        const nextWaiter = BlockingOverlayCoordinator.#waiters.shift();
        if (!nextWaiter)
        {
            return;
        }
        BlockingOverlayCoordinator.#activeOwnerId = nextWaiter.ownerId;
        nextWaiter.resolveWait();
    }
}

export default BlockingOverlayCoordinator;
