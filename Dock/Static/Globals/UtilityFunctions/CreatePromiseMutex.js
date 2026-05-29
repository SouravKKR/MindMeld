/**
 * Returns a tiny single-slot mutex. `acquire()` resolves once the previous
 * holder releases — the resolved value is the `release` function. Used by
 * SyncOrchestrator to serialise concurrent sync attempts without pulling
 * in a third-party lock library.
 *
 * Usage:
 *   const mutex = createPromiseMutex();
 *   const release = await mutex.acquire();
 *   try { ... } finally { release(); }
 */
export function createPromiseMutex()
{
    let currentSlotPromise = null;

    async function acquire()
    {
        while (currentSlotPromise)
        {
            await currentSlotPromise;
        }

        let releaseSlot;

        currentSlotPromise = new Promise((resolve) =>
        {
            releaseSlot = () =>
            {
                currentSlotPromise = null;
                resolve();
            };
        });

        return releaseSlot;
    }

    return { acquire };
}

export default createPromiseMutex;
