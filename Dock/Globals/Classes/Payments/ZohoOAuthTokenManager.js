const ZohoRegionConfig = require("./ZohoRegionConfig");

/**
 * ZohoOAuthTokenManager
 *
 * Exchanges the long-lived ZOHO_REFRESH_TOKEN for short-lived access tokens
 * (Zoho access tokens expire in ~1 hour) and caches the result in process
 * memory until shortly before expiry. Shared by BOTH server-side Zoho callers
 * — ZohoPaymentProvider (Payments API) and ZohoInvoiceService (Invoice API) —
 * because a single Zoho account / refresh token, scoped for both products,
 * backs them. The OAuth credentials and data-center region come from env via
 * ZohoRegionConfig, so there is exactly one source of truth for the token.
 *
 * Concurrency: concurrent callers that arrive while no fresh token is cached
 * share a single in-flight refresh promise rather than each hitting the token
 * endpoint (Zoho throttles refresh requests, and duplicate refreshes are pure
 * waste).
 */
class ZohoOAuthTokenManager
{
    // Refresh a minute early so a token never expires mid-request.
    static EXPIRY_SAFETY_MARGIN_MILLISECONDS = 60_000;

    static #cachedAccessToken = "";
    static #expiresAtMillis = 0;
    static #inFlightRefresh = null;

    static isConfigured()
    {
        return Boolean(
            (process.env.ZOHO_CLIENT_ID || "") &&
            (process.env.ZOHO_CLIENT_SECRET || "") &&
            (process.env.ZOHO_REFRESH_TOKEN || "")
        );
    }

    static async getAccessToken()
    {
        if (!ZohoOAuthTokenManager.isConfigured())
        {
            throw new Error("Zoho OAuth not configured: missing ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET or ZOHO_REFRESH_TOKEN");
        }

        const now = Date.now();
        if (ZohoOAuthTokenManager.#cachedAccessToken && now < ZohoOAuthTokenManager.#expiresAtMillis)
        {
            return ZohoOAuthTokenManager.#cachedAccessToken;
        }

        // Collapse concurrent refreshes onto one network call.
        if (!ZohoOAuthTokenManager.#inFlightRefresh)
        {
            ZohoOAuthTokenManager.#inFlightRefresh = ZohoOAuthTokenManager.#refreshAccessToken()
                .finally(() =>
                {
                    ZohoOAuthTokenManager.#inFlightRefresh = null;
                });
        }

        return await ZohoOAuthTokenManager.#inFlightRefresh;
    }

    static async #refreshAccessToken()
    {
        const parameters = new URLSearchParams
        ({
            refresh_token: process.env.ZOHO_REFRESH_TOKEN || "",
            client_id: process.env.ZOHO_CLIENT_ID || "",
            client_secret: process.env.ZOHO_CLIENT_SECRET || "",
            grant_type: "refresh_token"
        });

        // Zoho's token endpoint reads these as QUERY parameters on a POST (the
        // documented form), not a form body — send them in the URL.
        const tokenUrl = `${ZohoRegionConfig.getAccountsBaseUrl()}/oauth/v2/token?${parameters.toString()}`;

        const tokenResponse = await fetch(tokenUrl, { method: "POST" });

        const responseText = await tokenResponse.text();
        let tokenJson = null;
        try
        {
            tokenJson = JSON.parse(responseText);
        }
        catch (parseError)
        {
            throw new Error(`Zoho OAuth token refresh returned non-JSON: ${tokenResponse.status} ${responseText}`);
        }

        // Zoho returns HTTP 200 even for some error envelopes (e.g. an invalid
        // refresh token), so trust the presence of access_token, not the status.
        const accessToken = tokenJson?.access_token;
        if (!tokenResponse.ok || typeof accessToken !== "string" || accessToken.length === 0)
        {
            const errorDescription = tokenJson?.error || responseText;
            throw new Error(`Zoho OAuth token refresh failed: ${tokenResponse.status} ${errorDescription}`);
        }

        const expiresInSeconds = Number(tokenJson?.expires_in) || 3600;
        ZohoOAuthTokenManager.#cachedAccessToken = accessToken;
        ZohoOAuthTokenManager.#expiresAtMillis = Date.now() + (expiresInSeconds * 1000) - ZohoOAuthTokenManager.EXPIRY_SAFETY_MARGIN_MILLISECONDS;

        return accessToken;
    }
}

module.exports = ZohoOAuthTokenManager;
