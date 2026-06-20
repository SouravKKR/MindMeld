/**
 * ZohoRegionConfig
 *
 * Resolves the Zoho data-center region (set once via the ZOHO_REGION env var)
 * into the concrete domains every Zoho integration in this server needs:
 *
 *   accountsBaseUrl — OAuth token endpoint host (accounts.zoho.*)
 *   paymentsBaseUrl — Zoho Payments API host (payments.zoho.*)
 *   apisBaseUrl     — Zoho Invoice / general API host (www.zohoapis.*)
 *   widgetDomain    — the `domain` value the browser checkout widget expects
 *
 * A Zoho account lives in exactly ONE data center, so a single region drives
 * every host. An unrecognised / unset region falls back to India (IN), the
 * default for this deployment.
 */
class ZohoRegionConfig
{
    static DEFAULT_REGION = "IN";

    static #REGION_MAP =
    {
        IN: { accounts: "https://accounts.zoho.in", payments: "https://payments.zoho.in", apis: "https://www.zohoapis.in", widget: "IN" },
        US: { accounts: "https://accounts.zoho.com", payments: "https://payments.zoho.com", apis: "https://www.zohoapis.com", widget: "US" },
        EU: { accounts: "https://accounts.zoho.eu", payments: "https://payments.zoho.eu", apis: "https://www.zohoapis.eu", widget: "EU" },
        AU: { accounts: "https://accounts.zoho.com.au", payments: "https://payments.zoho.com.au", apis: "https://www.zohoapis.com.au", widget: "AU" },
        JP: { accounts: "https://accounts.zoho.jp", payments: "https://payments.zoho.jp", apis: "https://www.zohoapis.jp", widget: "JP" },
        CA: { accounts: "https://accounts.zohocloud.ca", payments: "https://payments.zohocloud.ca", apis: "https://www.zohoapis.ca", widget: "CA" },
        SA: { accounts: "https://accounts.zoho.sa", payments: "https://payments.zoho.sa", apis: "https://www.zohoapis.sa", widget: "SA" }
    };

    static getRegionCode()
    {
        const configured = String(process.env.ZOHO_REGION || ZohoRegionConfig.DEFAULT_REGION).toUpperCase();
        return ZohoRegionConfig.#REGION_MAP[configured] ? configured : ZohoRegionConfig.DEFAULT_REGION;
    }

    static #resolve()
    {
        return ZohoRegionConfig.#REGION_MAP[ZohoRegionConfig.getRegionCode()];
    }

    static getAccountsBaseUrl()
    {
        return ZohoRegionConfig.#resolve().accounts;
    }

    static getPaymentsBaseUrl()
    {
        return ZohoRegionConfig.#resolve().payments;
    }

    static getApisBaseUrl()
    {
        return ZohoRegionConfig.#resolve().apis;
    }

    static getWidgetDomain()
    {
        return ZohoRegionConfig.#resolve().widget;
    }
}

module.exports = ZohoRegionConfig;
