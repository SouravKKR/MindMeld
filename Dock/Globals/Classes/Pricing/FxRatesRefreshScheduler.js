const EcbRatesClient = require("./EcbRatesClient");

/**
 * FxRatesRefreshScheduler
 *
 * Refreshes the cached ECB FX snapshot once per day. Mirrors
 * KeyRotationScheduler: a single idempotent setInterval, an async tick whose
 * failures are caught and logged (EcbRatesClient already records an Alert),
 * so a failed refresh never disturbs the running app.
 */
class FxRatesRefreshScheduler
{
    static #REFRESH_INTERVAL_MILLISECONDS = 24 * 60 * 60 * 1000;
    static #intervalHandle = null;

    static start()
    {
        if (FxRatesRefreshScheduler.#intervalHandle !== null)
        {
            return;
        }

        FxRatesRefreshScheduler.#intervalHandle = setInterval
        (
            FxRatesRefreshScheduler.#tick,
            FxRatesRefreshScheduler.#REFRESH_INTERVAL_MILLISECONDS
        );
    }

    static stop()
    {
        if (FxRatesRefreshScheduler.#intervalHandle === null)
        {
            return;
        }
        clearInterval(FxRatesRefreshScheduler.#intervalHandle);
        FxRatesRefreshScheduler.#intervalHandle = null;
    }

    static async #tick()
    {
        try
        {
            await EcbRatesClient.fetchAndStoreLatestRates();
        }
        catch (refreshError)
        {
            console.error("[FxRatesRefreshScheduler] Daily ECB refresh failed:", refreshError);
        }
    }
}

module.exports = FxRatesRefreshScheduler;
