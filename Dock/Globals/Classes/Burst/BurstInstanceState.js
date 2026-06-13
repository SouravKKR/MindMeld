// Dock-side bookkeeping for one managed burst instance across reconcile ticks.
// The cloud provider only knows an instance's current status; the autoscaler
// also needs to know when an instance was first seen and when it last had work,
// to make idle-shutdown decisions. This holds that local-only state.

class BurstInstanceState
{
    #instanceId;
    #label;
    #firstSeenAtMilliseconds;
    #lastBusyAtMilliseconds;

    /**
     * @param {string} instanceId
     * @param {string} label
     * @param {number} nowMilliseconds
     */
    constructor(instanceId, label, nowMilliseconds)
    {
        this.#instanceId = String(instanceId);
        this.#label = label || "";
        this.#firstSeenAtMilliseconds = nowMilliseconds;
        // Seed last-busy to first-seen so a freshly created instance is given a
        // full idle window before it becomes eligible for shutdown.
        this.#lastBusyAtMilliseconds = nowMilliseconds;
    }

    getInstanceId()
    {
        return this.#instanceId;
    }

    getLabel()
    {
        return this.#label;
    }

    getFirstSeenAtMilliseconds()
    {
        return this.#firstSeenAtMilliseconds;
    }

    /**
     * Records that the fleet had work at this moment. Called whenever the queue
     * is non-empty: we can't attribute a specific task to a specific instance, so
     * any work keeps the whole pool's idle clock fresh — conservative, biasing
     * toward NOT shutting instances down prematurely.
     * @param {number} nowMilliseconds
     */
    markBusy(nowMilliseconds)
    {
        this.#lastBusyAtMilliseconds = nowMilliseconds;
    }

    /**
     * @param {number} nowMilliseconds
     * @returns {number} Milliseconds since this instance last had work to do.
     */
    idleMilliseconds(nowMilliseconds)
    {
        return nowMilliseconds - this.#lastBusyAtMilliseconds;
    }
}

module.exports = BurstInstanceState;
