const { regions } = require("../../Enumerations/Regions");

/**
 * RegionMetadata
 *
 * Single source of truth on the backend for the coarse buyer regions the
 * storefront prices against. The Regions enum (codegen) only carries
 * name -> int; everything a region needs at runtime — its human label, the
 * currency we display/convert prices into, and which ISO-3166 alpha-2
 * countries map onto it — lives here.
 *
 * Region codes used throughout the pricing path are the enum NAMES
 * ("INDIA", "EUROPE", ...). "GLOBAL" is intentionally NOT a region here:
 * it is a special catch-all value the PaidDeckPricing rows may use, and the
 * pricing engine handles it separately.
 */
class RegionMetadata
{
    static DEFAULT_REGION = "INDIA";

    // Every currency below is published in the ECB daily reference feed and
    // has 2 minor digits, so the existing minor-unit price model holds.
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

    // ISO-3166 alpha-2 country code -> region code. Countries not listed
    // fall back to DEFAULT_REGION. Single-country regions (US/CA/MX/BR/GB/SG)
    // are listed explicitly; the broad buckets (EUROPE / MIDDLE_EAST /
    // AFRICA / ASIA) carry a curated-but-non-exhaustive member set.
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

        // European Union + EEA + Switzerland.
        AT: "EUROPE", BE: "EUROPE", BG: "EUROPE", HR: "EUROPE", CY: "EUROPE",
        CZ: "EUROPE", DK: "EUROPE", EE: "EUROPE", FI: "EUROPE", FR: "EUROPE",
        DE: "EUROPE", GR: "EUROPE", HU: "EUROPE", IE: "EUROPE", IT: "EUROPE",
        LV: "EUROPE", LT: "EUROPE", LU: "EUROPE", MT: "EUROPE", NL: "EUROPE",
        PL: "EUROPE", PT: "EUROPE", RO: "EUROPE", SK: "EUROPE", SI: "EUROPE",
        ES: "EUROPE", SE: "EUROPE", IS: "EUROPE", LI: "EUROPE", NO: "EUROPE",
        CH: "EUROPE",

        // Middle East.
        AE: "MIDDLE_EAST", SA: "MIDDLE_EAST", QA: "MIDDLE_EAST", KW: "MIDDLE_EAST",
        BH: "MIDDLE_EAST", OM: "MIDDLE_EAST", IL: "MIDDLE_EAST", JO: "MIDDLE_EAST",
        LB: "MIDDLE_EAST", TR: "MIDDLE_EAST", IR: "MIDDLE_EAST", IQ: "MIDDLE_EAST",

        // Africa.
        ZA: "AFRICA", NG: "AFRICA", EG: "AFRICA", KE: "AFRICA", GH: "AFRICA",
        MA: "AFRICA", TZ: "AFRICA", ET: "AFRICA", UG: "AFRICA", DZ: "AFRICA",
        TN: "AFRICA", CI: "AFRICA", SN: "AFRICA", CM: "AFRICA", ZW: "AFRICA",

        // Rest of Asia (India and Singapore handled above).
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

    /**
     * Maps an ISO-3166 alpha-2 country code (case-insensitive) to a region
     * code, or null when the country is unknown so the caller can fall
     * through to the next detection layer.
     */
    static countryToRegion(countryCode)
    {
        if (typeof countryCode !== "string" || countryCode.length === 0)
        {
            return null;
        }
        return RegionMetadata.#COUNTRY_TO_REGION[countryCode.trim().toUpperCase()] || null;
    }

    /**
     * Distinct display currencies across all regions, sorted alphabetically.
     * This is the set an admin can price credits in — every buyer currency
     * resolves to one of these via getDisplayCurrency.
     */
    static getSupportedCurrencies()
    {
        return Array.from(new Set(Object.values(RegionMetadata.#DISPLAY_CURRENCY))).sort();
    }

    /**
     * Region list for the storefront switcher — code, label, and the
     * currency prices are shown in for that region. Ordered by the enum.
     */
    static getAllRegions()
    {
        return Object.keys(regions).map((regionCode) =>
        ({
            code: regionCode,
            label: RegionMetadata.getLabel(regionCode),
            currency: RegionMetadata.getDisplayCurrency(regionCode)
        }));
    }
}

module.exports = RegionMetadata;
