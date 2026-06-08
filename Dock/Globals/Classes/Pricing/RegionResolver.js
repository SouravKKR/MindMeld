const RegionMetadata = require("./RegionMetadata");

/**
 * RegionResolver
 *
 * Resolves the buyer region used for storefront pricing from a request,
 * following the agreed cascade:
 *   1. an explicit region (manual switcher / request body) when valid;
 *   2. Cloudflare's CF-IPCountry request header -> region;
 *   3. a client-supplied locale region hint -> region (validated);
 *   4. the default region (INDIA).
 *
 * Header note: Packetron exposes request headers on `request.headers` with
 * lowercase keys (see HandleRazorpayWebhook.js), so CF-IPCountry arrives as
 * `request.headers["cf-ipcountry"]` when the app runs behind the Cloudflare
 * tunnel. Offline/dev requests simply skip straight to the locale hint or
 * default.
 */
class RegionResolver
{
    static resolveRegion(request, explicitRegion = null, localeRegionHint = null)
    {
        // 1. Explicit manual override.
        if (RegionMetadata.isValidRegion(explicitRegion))
        {
            return explicitRegion;
        }

        // 2. Cloudflare country header.
        const headers = (request && request.headers) ? request.headers : {};
        const cloudflareCountry = headers["cf-ipcountry"] || headers["CF-IPCountry"];
        if (typeof cloudflareCountry === "string")
        {
            const headerRegion = RegionMetadata.countryToRegion(cloudflareCountry);
            if (headerRegion)
            {
                return headerRegion;
            }
        }

        // 3. Client locale hint (already a region code guessed by the browser).
        if (RegionMetadata.isValidRegion(localeRegionHint))
        {
            return localeRegionHint;
        }

        // 4. Default.
        return RegionMetadata.DEFAULT_REGION;
    }
}

module.exports = RegionResolver;
