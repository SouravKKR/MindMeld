const { PacketronPlugin, PacketronPluginPriority } = require("@gamiumgamers/packetron");

/**
 * SecurityHeaders
 *
 * A single global plugin that stamps the standard security response headers on
 * EVERY response — API endpoints, the SPA shell and all static assets alike.
 * Because Packetron runs global plugins before routing (see index.js), setting
 * the headers here guarantees they are present before any handler or the file
 * router writes the body, including on short-circuit responses such as the
 * rate-limiter's 429 or the legal-gate's 403.
 *
 *   • Content-Security-Policy   — restricts where resources may load from.
 *   • X-Frame-Options           — legacy clickjacking defense (paired with the
 *                                 CSP frame-ancestors directive).
 *   • X-Content-Type-Options    — stops MIME sniffing.
 *   • Referrer-Policy           — trims the Referer sent cross-origin.
 *   • Strict-Transport-Security  — forces HTTPS (emitted only on secure requests
 *                                 so plain-http local development is unaffected).
 *
 * Compatibility-first CSP. MindMeld embeds third parties that are hostile to a
 * strict nonce/hash policy: Google AdSense, the Razorpay checkout, Google OAuth,
 * and in-browser LLMs (WebLLM / Transformers.js) that compile WebAssembly, spawn
 * blob-URL workers and stream model shards from huggingface.co. The Web
 * Components also render inline styles throughout. The default policy therefore
 * locks the high-value, no-risk directives (object-src none, base-uri self,
 * frame-ancestors self, form-action) while permitting the https:/inline/eval/
 * wasm/blob sources this stack genuinely needs — so the policy ships real value
 * without breaking any existing functionality. Every part is overridable from
 * the environment for operators who want to tighten it later.
 *
 * Environment overrides (all optional):
 *   SECURITY_HEADERS_DISABLED            "true" disables the plugin entirely.
 *   CONTENT_SECURITY_POLICY              full verbatim policy string (replaces the default).
 *   CONTENT_SECURITY_POLICY_REPORT_ONLY  "true" sends the policy in report-only mode.
 *   REFERRER_POLICY                      default "strict-origin-when-cross-origin".
 *   X_FRAME_OPTIONS                      default "SAMEORIGIN".
 *   HSTS_MAX_AGE_SECONDS                 default 15552000 (180 days). "0" disables HSTS.
 *   HSTS_INCLUDE_SUBDOMAINS              default "true".
 *   HSTS_PRELOAD                         default "false".
 */
class SecurityHeaders
{
    static DEFAULT_REFERRER_POLICY = "strict-origin-when-cross-origin";
    static DEFAULT_X_FRAME_OPTIONS = "SAMEORIGIN";
    static DEFAULT_HSTS_MAX_AGE_SECONDS = 15552000;

    // The compatibility-first default policy. Source lists intentionally allow
    // https: (so any third-party HTTPS origin the app uses keeps working) while
    // the framing / base-uri / object directives stay strictly locked down.
    static CONTENT_SECURITY_POLICY_DIRECTIVES =
    {
        "default-src":     ["'self'"],
        "script-src":      ["'self'", "'unsafe-inline'", "'unsafe-eval'", "'wasm-unsafe-eval'", "blob:", "https:"],
        "style-src":       ["'self'", "'unsafe-inline'", "https:"],
        "img-src":         ["'self'", "data:", "blob:", "https:"],
        "font-src":        ["'self'", "data:", "https:"],
        "connect-src":     ["'self'", "https:", "wss:", "data:", "blob:"],
        "media-src":       ["'self'", "data:", "blob:", "https:"],
        "worker-src":      ["'self'", "blob:"],
        "child-src":       ["'self'", "blob:", "https:"],
        "frame-src":       ["'self'", "https:"],
        "manifest-src":    ["'self'"],
        "object-src":      ["'none'"],
        "base-uri":        ["'self'"],
        "form-action":     ["'self'", "https:"],
        "frame-ancestors": ["'self'"]
    };

    static __cachedContentSecurityPolicy = null;

    static isDisabled()
    {
        return String(process.env.SECURITY_HEADERS_DISABLED || "").toLowerCase() === "true";
    }

    static isReportOnly()
    {
        return String(process.env.CONTENT_SECURITY_POLICY_REPORT_ONLY || "").toLowerCase() === "true";
    }

    static buildContentSecurityPolicy()
    {
        if (SecurityHeaders.__cachedContentSecurityPolicy !== null)
        {
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        const override = process.env.CONTENT_SECURITY_POLICY;
        if (override && override.trim().length > 0)
        {
            SecurityHeaders.__cachedContentSecurityPolicy = override.trim();
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        const serializedDirectives = [];
        for (const [directiveName, sources] of Object.entries(SecurityHeaders.CONTENT_SECURITY_POLICY_DIRECTIVES))
        {
            serializedDirectives.push(`${directiveName} ${sources.join(" ")}`);
        }

        SecurityHeaders.__cachedContentSecurityPolicy = serializedDirectives.join("; ");
        return SecurityHeaders.__cachedContentSecurityPolicy;
    }

    static buildStrictTransportSecurity()
    {
        const maxAgeRaw = process.env.HSTS_MAX_AGE_SECONDS;
        const maxAgeSeconds = maxAgeRaw === undefined || maxAgeRaw === null || maxAgeRaw === ""
            ? SecurityHeaders.DEFAULT_HSTS_MAX_AGE_SECONDS
            : Number.parseInt(maxAgeRaw, 10);

        if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0)
        {
            return null;
        }

        let value = `max-age=${maxAgeSeconds}`;

        const includeSubDomains = String(process.env.HSTS_INCLUDE_SUBDOMAINS || "true").toLowerCase() !== "false";
        if (includeSubDomains)
        {
            value += "; includeSubDomains";
        }

        if (String(process.env.HSTS_PRELOAD || "false").toLowerCase() === "true")
        {
            value += "; preload";
        }

        return value;
    }

    static isSecureRequest(request)
    {
        const forwardedProtocol = String((request.headers && request.headers["x-forwarded-proto"]) || "").split(",")[0].trim().toLowerCase();
        if (forwardedProtocol)
        {
            return forwardedProtocol === "https";
        }

        return Boolean(request.socket && request.socket.encrypted);
    }

    static apply(request, response)
    {
        if (SecurityHeaders.isDisabled())
        {
            return;
        }

        const contentSecurityPolicyHeaderName = SecurityHeaders.isReportOnly()
            ? "Content-Security-Policy-Report-Only"
            : "Content-Security-Policy";

        response.setHeader(contentSecurityPolicyHeaderName, SecurityHeaders.buildContentSecurityPolicy());
        response.setHeader("X-Frame-Options", process.env.X_FRAME_OPTIONS || SecurityHeaders.DEFAULT_X_FRAME_OPTIONS);
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Referrer-Policy", process.env.REFERRER_POLICY || SecurityHeaders.DEFAULT_REFERRER_POLICY);

        // HSTS only means anything over HTTPS, and asserting it on plain-http
        // local development would be wrong, so emit it only for secure requests.
        if (SecurityHeaders.isSecureRequest(request))
        {
            const strictTransportSecurity = SecurityHeaders.buildStrictTransportSecurity();
            if (strictTransportSecurity)
            {
                response.setHeader("Strict-Transport-Security", strictTransportSecurity);
            }
        }
    }
}

const securityHeadersPlugin = new PacketronPlugin
({
    // Highest priority so the headers are in place before any other global
    // plugin can short-circuit the request (e.g. the rate limiter's 429).
    priority: PacketronPluginPriority.EXTEMELY_HIGH,
    handler: (request, response) =>
    {
        try
        {
            SecurityHeaders.apply(request, response);
        }
        catch (securityHeaderError)
        {
            console.error("[SecurityHeaders] Failed to apply security headers:", securityHeaderError);
        }

        // Never handles the request — always continue to the next plugin/router.
        return false;
    }
});

module.exports = { securityHeadersPlugin, SecurityHeaders };
