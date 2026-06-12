const { createClient } = require("redis");

/**
 * ForeignExchangeRatesCache
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
class ForeignExchangeRatesCache
{
    static #redisClient = null;
    static #KEY = "ForeignExchangeRates/latest";
    static #STALE_AFTER_MILLISECONDS = 24 * 60 * 60 * 1000;

    static async initialize()
    {
        if (ForeignExchangeRatesCache.#redisClient !== null)
        {
            return;
        }
        ForeignExchangeRatesCache.#redisClient = createClient();
        await ForeignExchangeRatesCache.#redisClient.connect();
        console.log("ForeignExchangeRatesCache initialized.");
    }

    static isReady()
    {
        return ForeignExchangeRatesCache.#redisClient !== null;
    }

    /**
     * Returns the stored snapshot object, or null when nothing has been
     * cached yet or Redis is unavailable. Never throws.
     */
    static async getSnapshot()
    {
        if (ForeignExchangeRatesCache.#redisClient === null)
        {
            return null;
        }
        try
        {
            const rawSnapshot = await ForeignExchangeRatesCache.#redisClient.get(ForeignExchangeRatesCache.#KEY);
            if (!rawSnapshot)
            {
                return null;
            }
            return JSON.parse(typeof rawSnapshot === "string" ? rawSnapshot : rawSnapshot.toString());
        }
        catch (readError)
        {
            console.error("[ForeignExchangeRatesCache] Failed to read snapshot:", readError);
            return null;
        }
    }

    /**
     * Persists a snapshot forever (no EX). `rates` should be the EUR-based
     * map; `fetchedAt` is stamped here.
     */
    static async storeSnapshot({ rates, sourceDate })
    {
        if (ForeignExchangeRatesCache.#redisClient === null)
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
        await ForeignExchangeRatesCache.#redisClient.set(ForeignExchangeRatesCache.#KEY, JSON.stringify(snapshot));
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
        return (Date.now() - fetchedMilliseconds) > ForeignExchangeRatesCache.#STALE_AFTER_MILLISECONDS;
    }
}

module.exports = ForeignExchangeRatesCache;
