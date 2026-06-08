const FxRatesCache = require("./FxRatesCache");
const EcbRatesClient = require("./EcbRatesClient");
const Alerts = require("../Alerts/Alerts");

/**
 * CurrencyConverter
 *
 * Converts minor-unit amounts between currencies using the cached ECB
 * snapshot (EUR-based cross rates: amount_to = amount_from * rateTo / rateFrom).
 *
 * Conversion never throws and never blocks on the network: it reads the
 * current Redis snapshot synchronously-ish and, if the snapshot is missing
 * or stale, kicks off a best-effort refresh for NEXT time while serving the
 * current data. If a required rate is unavailable it degrades gracefully —
 * the original amount + currency are returned unchanged (so a buyer always
 * sees a real price, just not localized) and a one-time Alert is raised.
 *
 * All target currencies in use have 2 minor digits, matching the rest of the
 * price model, so minor units convert proportionally without scale changes.
 */
class CurrencyConverter
{
    static #SOURCE = "CURRENCY_CONVERTER";

    /**
     * @returns {Promise<{ amountMinor: number, currency: string, converted: boolean }>}
     */
    static async convertMinor(amountMinor, fromCurrency, toCurrency)
    {
        const safeAmount = Number(amountMinor) || 0;
        const from = typeof fromCurrency === "string" ? fromCurrency.toUpperCase() : "";
        const to = typeof toCurrency === "string" ? toCurrency.toUpperCase() : "";

        if (!from || !to || from === to)
        {
            return { amountMinor: safeAmount, currency: from || to || "INR", converted: from === to };
        }

        const snapshot = await FxRatesCache.getSnapshot();

        // Opportunistically refresh for next time when empty/stale; do not
        // await — this call must stay fast.
        if (!snapshot || FxRatesCache.isSnapshotStale(snapshot))
        {
            EcbRatesClient.fetchAndStoreLatestRates().catch(() => {});
        }

        const rates = snapshot && snapshot.rates ? snapshot.rates : null;
        const fromRate = rates ? rates[from] : undefined;
        const toRate = rates ? rates[to] : undefined;

        if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0)
        {
            await Alerts.warning
            (
                CurrencyConverter.#SOURCE,
                "Currency conversion unavailable — showing original currency",
                `Missing ECB rate for ${from}->${to} (cache ${snapshot ? "present" : "empty"}). Prices in this currency are shown unconverted until rates are available.`,
                { from, to, haveSnapshot: Boolean(snapshot) }
            );
            return { amountMinor: safeAmount, currency: from, converted: false };
        }

        const convertedMinor = Math.round(safeAmount * (toRate / fromRate));
        return { amountMinor: convertedMinor, currency: to, converted: true };
    }
}

module.exports = CurrencyConverter;
