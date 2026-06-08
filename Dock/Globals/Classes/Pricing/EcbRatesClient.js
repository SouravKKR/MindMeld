const FxRatesCache = require("./FxRatesCache");
const Alerts = require("../Alerts/Alerts");

/**
 * EcbRatesClient
 *
 * Fetches the European Central Bank daily reference rates and stores them in
 * FxRatesCache. The feed is EUR-based; EUR is the implicit base (rate 1) and
 * is therefore not present in the XML.
 *
 * The feed is a tiny, flat XML document, so it is parsed with a regex rather
 * than pulling in an XML dependency (the repo convention is native fetch + no
 * extra HTTP/XML libs). If the structure ever changes — the regex stops
 * matching, or expected major currencies vanish — we DO NOT overwrite the
 * last good snapshot, and we raise an admin Alert describing the likely
 * URL/format change. Network or HTTP failures are likewise alerted, never
 * thrown to callers.
 */
class EcbRatesClient
{
    static #SOURCE = "ECB_RATES";
    static #DEFAULT_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
    // Sanity gates so a truncated/garbage response can't masquerade as valid.
    static #MINIMUM_RATE_COUNT = 10;
    static #REQUIRED_CURRENCIES = ["USD", "INR"];

    static #inFlight = null;

    static #getUrl()
    {
        const configured = process.env.ECB_RATES_URL;
        return (typeof configured === "string" && configured.trim().length > 0)
            ? configured.trim()
            : EcbRatesClient.#DEFAULT_URL;
    }

    /**
     * Parses the ECB XML text into an EUR-based rate map and the source
     * date. Returns null when nothing usable could be extracted.
     */
    static #parse(xmlText)
    {
        if (typeof xmlText !== "string" || xmlText.length === 0)
        {
            return null;
        }

        const rates = {};
        const pairPattern = /currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([0-9]*\.?[0-9]+)['"]/g;
        let match;
        while ((match = pairPattern.exec(xmlText)) !== null)
        {
            const currencyCode = match[1].toUpperCase();
            const rateValue = parseFloat(match[2]);
            if (Number.isFinite(rateValue) && rateValue > 0)
            {
                rates[currencyCode] = rateValue;
            }
        }

        // EUR is the base and never appears in the feed; make it explicit so
        // conversions to/from EUR are uniform.
        rates.EUR = 1;

        const dateMatch = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xmlText);
        const sourceDate = dateMatch ? dateMatch[1] : null;

        return { rates, sourceDate };
    }

    static #isStructurallyValid(parsed)
    {
        if (!parsed || !parsed.rates)
        {
            return false;
        }
        // EUR is injected, so require the count excluding it.
        const foreignCount = Object.keys(parsed.rates).filter(code => code !== "EUR").length;
        if (foreignCount < EcbRatesClient.#MINIMUM_RATE_COUNT)
        {
            return false;
        }
        return EcbRatesClient.#REQUIRED_CURRENCIES.every(code => Number.isFinite(parsed.rates[code]));
    }

    /**
     * Fetches the latest rates and stores them. Returns true on success,
     * false on any failure (already alerted). Concurrent calls share one
     * in-flight request.
     */
    static async fetchAndStoreLatestRates()
    {
        if (EcbRatesClient.#inFlight)
        {
            return EcbRatesClient.#inFlight;
        }
        EcbRatesClient.#inFlight = EcbRatesClient.#doFetchAndStore();
        try
        {
            return await EcbRatesClient.#inFlight;
        }
        finally
        {
            EcbRatesClient.#inFlight = null;
        }
    }

    static async #doFetchAndStore()
    {
        const url = EcbRatesClient.#getUrl();
        try
        {
            const response = await fetch(url);
            if (!response.ok)
            {
                await Alerts.error
                (
                    EcbRatesClient.#SOURCE,
                    "ECB rates fetch returned a non-OK status",
                    `GET ${url} responded ${response.status} ${response.statusText}. Keeping the last cached snapshot.`,
                    { url, status: response.status }
                );
                return false;
            }

            const xmlText = await response.text();
            const parsed = EcbRatesClient.#parse(xmlText);

            if (!EcbRatesClient.#isStructurallyValid(parsed))
            {
                await Alerts.error
                (
                    EcbRatesClient.#SOURCE,
                    "ECB rates feed structure looks invalid",
                    `Could not extract the expected currency/rate pairs from ${url} — the URL or XML format may have changed. The previous snapshot has been kept.`,
                    { url, parsedCount: parsed ? Object.keys(parsed.rates).length : 0 }
                );
                return false;
            }

            await FxRatesCache.storeSnapshot({ rates: parsed.rates, sourceDate: parsed.sourceDate });
            console.log(`[EcbRatesClient] Stored ECB rates for ${parsed.sourceDate || "unknown date"} (${Object.keys(parsed.rates).length} currencies).`);
            return true;
        }
        catch (fetchError)
        {
            await Alerts.error
            (
                EcbRatesClient.#SOURCE,
                "ECB rates fetch failed",
                `Fetching ${url} threw: ${fetchError && fetchError.message ? fetchError.message : String(fetchError)}. Keeping the last cached snapshot.`,
                { url }
            );
            return false;
        }
    }
}

module.exports = EcbRatesClient;
