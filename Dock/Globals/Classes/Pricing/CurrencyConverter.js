const ForeignExchangeRatesCache = require("./ForeignExchangeRatesCache");
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
        const fromCurrencyCode = typeof fromCurrency === "string" ? fromCurrency.toUpperCase() : "";
        const toCurrencyCode = typeof toCurrency === "string" ? toCurrency.toUpperCase() : "";

        if (!fromCurrencyCode || !toCurrencyCode || fromCurrencyCode === toCurrencyCode)
        {
            return { amountMinor: safeAmount, currency: fromCurrencyCode || toCurrencyCode || "INR", converted: fromCurrencyCode === toCurrencyCode };
        }

        const snapshot = await ForeignExchangeRatesCache.getSnapshot();

        // Opportunistically refresh for next time when empty/stale; do not
        // await — this call must stay fast.
        if (!snapshot || ForeignExchangeRatesCache.isSnapshotStale(snapshot))
        {
            EcbRatesClient.fetchAndStoreLatestRates().catch(() => {});
        }

        const rates = snapshot && snapshot.rates ? snapshot.rates : null;
        const fromCurrencyRate = rates ? rates[fromCurrencyCode] : undefined;
        const toCurrencyRate = rates ? rates[toCurrencyCode] : undefined;

        if (!Number.isFinite(fromCurrencyRate) || !Number.isFinite(toCurrencyRate) || fromCurrencyRate <= 0)
        {
            await Alerts.warning
            (
                CurrencyConverter.#SOURCE,
                "Currency conversion unavailable — showing original currency",
                `Missing ECB rate for ${fromCurrencyCode}->${toCurrencyCode} (cache ${snapshot ? "present" : "empty"}). Prices in this currency are shown unconverted until rates are available.`,
                { fromCurrency: fromCurrencyCode, toCurrency: toCurrencyCode, haveSnapshot: Boolean(snapshot) }
            );
            return { amountMinor: safeAmount, currency: fromCurrencyCode, converted: false };
        }

        const convertedMinor = Math.round(safeAmount * (toCurrencyRate / fromCurrencyRate));
        return { amountMinor: convertedMinor, currency: toCurrencyCode, converted: true };
    }
}

module.exports = CurrencyConverter;
