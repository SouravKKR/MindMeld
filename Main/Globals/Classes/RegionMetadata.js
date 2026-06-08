import { regions } from "../Enumerations/Regions.js";

/**
 * RegionMetadata (frontend)
 *
 * Small hand-mirror of the backend Dock/Globals/Classes/Pricing/RegionMetadata.js.
 * Drives the storefront region switcher (code -> label -> display currency)
 * and produces a coarse locale-based region guess that the client sends as a
 * hint; the backend still has the authoritative cascade (CF-IPCountry wins).
 *
 * Region codes are the Regions enum NAMES ("INDIA", "EUROPE", ...).
 */
class RegionMetadata
{
    static DEFAULT_REGION = "INDIA";

    static #DISPLAY_CURRENCY =
    {
        INDIA: "INR",
        EUROPE: "EUR",
        UNITED_KINGDOM: "GBP",
        UNITED_STATES: "USD",
        CANADA: "CAD",
        MEXICO: "MXN",
        BRAZIL: "BRL",
        ASIA: "USD",
        AUSTRALIA: "AUD",
        SINGAPORE: "SGD",
        MIDDLE_EAST: "USD",
        AFRICA: "USD"
    };

    static #LABEL =
    {
        INDIA: "India",
        EUROPE: "Europe",
        UNITED_KINGDOM: "United Kingdom",
        UNITED_STATES: "United States",
        CANADA: "Canada",
        MEXICO: "Mexico",
        BRAZIL: "Brazil",
        ASIA: "Asia",
        AUSTRALIA: "Australia",
        SINGAPORE: "Singapore",
        MIDDLE_EAST: "Middle East",
        AFRICA: "Africa"
    };

    static #COUNTRY_TO_REGION =
    {
        IN: "INDIA",
        GB: "UNITED_KINGDOM",
        US: "UNITED_STATES",
        CA: "CANADA",
        MX: "MEXICO",
        BR: "BRAZIL",
        SG: "SINGAPORE",
        AU: "AUSTRALIA", NZ: "AUSTRALIA",
        AT: "EUROPE", BE: "EUROPE", BG: "EUROPE", HR: "EUROPE", CY: "EUROPE",
        CZ: "EUROPE", DK: "EUROPE", EE: "EUROPE", FI: "EUROPE", FR: "EUROPE",
        DE: "EUROPE", GR: "EUROPE", HU: "EUROPE", IE: "EUROPE", IT: "EUROPE",
        LV: "EUROPE", LT: "EUROPE", LU: "EUROPE", MT: "EUROPE", NL: "EUROPE",
        PL: "EUROPE", PT: "EUROPE", RO: "EUROPE", SK: "EUROPE", SI: "EUROPE",
        ES: "EUROPE", SE: "EUROPE", IS: "EUROPE", LI: "EUROPE", NO: "EUROPE",
        CH: "EUROPE",
        AE: "MIDDLE_EAST", SA: "MIDDLE_EAST", QA: "MIDDLE_EAST", KW: "MIDDLE_EAST",
        BH: "MIDDLE_EAST", OM: "MIDDLE_EAST", IL: "MIDDLE_EAST", JO: "MIDDLE_EAST",
        LB: "MIDDLE_EAST", TR: "MIDDLE_EAST", IR: "MIDDLE_EAST", IQ: "MIDDLE_EAST",
        ZA: "AFRICA", NG: "AFRICA", EG: "AFRICA", KE: "AFRICA", GH: "AFRICA",
        MA: "AFRICA", TZ: "AFRICA", ET: "AFRICA", UG: "AFRICA", DZ: "AFRICA",
        TN: "AFRICA", CI: "AFRICA", SN: "AFRICA", CM: "AFRICA", ZW: "AFRICA",
        CN: "ASIA", JP: "ASIA", KR: "ASIA", ID: "ASIA", MY: "ASIA",
        TH: "ASIA", PH: "ASIA", VN: "ASIA", BD: "ASIA", PK: "ASIA",
        LK: "ASIA", NP: "ASIA", HK: "ASIA", TW: "ASIA", KH: "ASIA",
        MM: "ASIA", MO: "ASIA"
    };

    static isValidRegion(regionCode)
    {
        return typeof regionCode === "string"
            && Object.prototype.hasOwnProperty.call(RegionMetadata.#DISPLAY_CURRENCY, regionCode);
    }

    static getDisplayCurrency(regionCode)
    {
        return RegionMetadata.#DISPLAY_CURRENCY[regionCode] || "INR";
    }

    static getLabel(regionCode)
    {
        return RegionMetadata.#LABEL[regionCode] || regionCode;
    }

    static getAllRegions()
    {
        return Object.keys(regions).map((regionCode) =>
        ({
            code: regionCode,
            label: RegionMetadata.getLabel(regionCode),
            currency: RegionMetadata.getDisplayCurrency(regionCode)
        }));
    }

    static #countryToRegion(countryCode)
    {
        if (typeof countryCode !== "string" || countryCode.length === 0)
        {
            return null;
        }
        return RegionMetadata.#COUNTRY_TO_REGION[countryCode.trim().toUpperCase()] || null;
    }

    /**
     * Best-effort region guess from the browser's locale. Tries the locale's
     * region subtag (e.g. "en-IN" -> "IN"), then the resolved timezone's
     * implied country is intentionally NOT inferred (unreliable) — returns
     * null when nothing maps, letting the backend fall back to its default.
     */
    static guessRegionFromLocale()
    {
        try
        {
            const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
                ? navigator.languages
                : [navigator.language];

            for (const languageTag of languages)
            {
                if (typeof languageTag !== "string" || languageTag.length === 0)
                {
                    continue;
                }
                let regionSubtag = null;
                try
                {
                    regionSubtag = new Intl.Locale(languageTag).region;
                }
                catch (localeError)
                {
                    const parts = languageTag.split("-");
                    regionSubtag = parts.length > 1 ? parts[1] : null;
                }
                const mapped = RegionMetadata.#countryToRegion(regionSubtag);
                if (mapped)
                {
                    return mapped;
                }
            }
        }
        catch (guessError)
        {
            // Non-fatal — fall through to null.
        }
        return null;
    }
}

export default RegionMetadata;
