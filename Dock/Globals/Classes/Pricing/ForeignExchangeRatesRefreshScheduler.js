const EcbRatesClient = require("./EcbRatesClient");

/**
 * ForeignExchangeRatesRefreshScheduler
 *
 * Refreshes the cached ECB foreign-exchange snapshot once per day. Mirrors
 * KeyRotationScheduler: a single idempotent setInterval, an async tick whose
 * failures are caught and logged (EcbRatesClient already records an Alert),
 * so a failed refresh never disturbs the running app.
 */
class ForeignExchangeRatesRefreshScheduler
{
    static #REFRESH_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
    static #intervalHandle = null;

    static start()
    {
        if (ForeignExchangeRatesRefreshScheduler.#intervalHandle !== null)
        {
            return;
        }

        ForeignExchangeRatesRefreshScheduler.#intervalHandle = setInterval
        (
            ForeignExchangeRatesRefreshScheduler.#tick,
            ForeignExchangeRatesRefreshScheduler.#REFRESH_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (ForeignExchangeRatesRefreshScheduler.#intervalHandle === null)
        {
            return;
        }
        clearInterval(ForeignExchangeRatesRefreshScheduler.#intervalHandle);
        ForeignExchangeRatesRefreshScheduler.#intervalHandle = null;
    }

    static async #tick()
    {
        try
        {
            await EcbRatesClient.fetchAndStoreLatestRates();
        }
        catch (refreshError)
        {
            console.error("[ForeignExchangeRatesRefreshScheduler] Daily ECB refresh failed:", refreshError);
        }
    }
}

module.exports = ForeignExchangeRatesRefreshScheduler;
