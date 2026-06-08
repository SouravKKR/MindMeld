const { createClient } = require("redis");

/**
 * FxRatesCache
 *
 * Redis-backed store for the latest ECB foreign-exchange snapshot. Mirrors
 * the static-client pattern used by TaskManager (bare createClient() against
 * the local Redis). The snapshot is stored WITHOUT an expiry — per the spec
 * we keep the last successful update forever, so a prolonged ECB outage
 * never leaves us with no rates at all; we just serve the last good ones.
 *
 * Snapshot shape:
 *   { base: "EUR", rates: { USD: 1.08, INR: 90.2, ... }, fetchedAt: ISO, sourceDate: "YYYY-MM-DD" }
 * Rates are EUR-based (EUR itself is implicit 1).
 */
class FxRatesCache
{
    static #redisClient = null;
    static #KEY = "Fx/latest";
    static #STALE_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;

    static async initialize()
    {
        if (FxRatesCache.#redisClient !== null)
        {
            return;
        }
        FxRatesCache.#redisClient = createClient();
        await FxRatesCache.#redisClient.connect();
        console.log("FxRatesCache initialized.");
    }

    static isReady()
    {
        return FxRatesCache.#redisClient !== null;
    }

    /**
     * Returns the stored snapshot object, or null when nothing has been
     * cached yet or Redis is unavailable. Never throws.
     */
    static async getSnapshot()
    {
        if (FxRatesCache.#redisClient === null)
        {
            return null;
        }
        try
        {
            const raw = await FxRatesCache.#redisClient.get(FxRatesCache.#KEY);
            if (!raw)
            {
                return null;
            }
            return JSON.parse(typeof raw === "string" ? raw : raw.toString());
        }
        catch (readError)
        {
            console.error("[FxRatesCache] Failed to read snapshot:", readError);
            return null;
        }
    }

    /**
     * Persists a snapshot forever (no EX). `rates` should be the EUR-based
     * map; `fetchedAt` is stamped here.
     */
    static async storeSnapshot({ rates, sourceDate })
    {
        if (FxRatesCache.#redisClient === null)
        {
            return false;
        }
        const snapshot =
        {
            base: "EUR",
            rates: rates,
            sourceDate: sourceDate || null,
            fetchedAt: new Date().toISOString()
        };
        await FxRatesCache.#redisClient.set(FxRatesCache.#KEY, JSON.stringify(snapshot));
        return true;
    }

    static isSnapshotStale(snapshot)
    {
        if (!snapshot || !snapshot.fetchedAt)
        {
            return true;
        }
        const fetchedMilliseconds = new Date(snapshot.fetchedAt).getTime();
        if (isNaN(fetchedMilliseconds))
        {
            return true;
        }
        return (Date.now() - fetchedMilliseconds) > FxRatesCache.#STALE_AFTER_MILLISECONDS;
    }
}

module.exports = FxRatesCache;
