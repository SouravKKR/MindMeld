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
 * Compatibility-first CSP. CogniumLearn embeds third parties that are hostile to a
 * strict nonce/hash policy: Google AdSense, the Zoho Payments checkout widget,
 * Google OAuth,
 * and in-browser LLMs (WebLLM / Transformers.js) that compile WebAssembly, spawn
 * blob-URL workers and stream model shards from huggingface.co. The Web
 * Components also render inline styles throughout. The default policy therefore
 * locks the high-value, no-risk directives (object-src none, base-uri self,
 * frame-ancestors self, form-action) while permitting the https:/inline/eval/
 * wasm/blob sources this stack genuinely needs — so the policy ships real value
 * without breaking any existing functionality. Every part is overridable from
 * the environment for operators who want to tighten it later.
 *
 * ── The strict policy and its staged rollout ──────────────────────────────
 *
 * A second, STRICT policy is defined alongside the compatible one. It drops
 * 'unsafe-inline' and 'unsafe-eval' from script-src and replaces the blanket
 * https: source with an explicit allow-list of the origins the app actually
 * loads scripts from. Both removals are believed safe for first-party code:
 * neither app shell contains a single inline <script> or inline event handler
 * (every script is an external src), and the only Function-constructor call in
 * the bundled stack is a `typeof globalThis === "object" ? … : Function("return
 * this")()` fallback that no browser capable of running this app ever reaches.
 * style-src deliberately KEEPS 'unsafe-inline' — the Web Components genuinely
 * render inline styles, and inline style is a far smaller risk than inline
 * script.
 *
 * What cannot be verified from the source alone is whether the remote third
 * parties (AdSense in particular) inject inline scripts at runtime. So the
 * strict policy is NOT enforced by default. In the default "compatible" mode
 * the compatible policy is enforced exactly as before and the strict policy
 * rides along as Content-Security-Policy-Report-Only, pointed at
 * /Security/CspReport. Browsers then report what the strict policy WOULD have
 * blocked without blocking anything, the reports land in the admin Alerts tab,
 * and once they come back clean an operator promotes the strict policy to
 * enforcing with a single environment variable. That is the whole point of the
 * mode switch: the tightening ships observable and reversible rather than as a
 * flag day.
 *
 * Environment overrides (all optional):
 *   SECURITY_HEADERS_DISABLED            "true" disables the plugin entirely.
 *   CONTENT_SECURITY_POLICY              full verbatim policy string (replaces the default,
 *                                        and suppresses the report-only companion — an
 *                                        operator supplying a policy owns it entirely).
 *   CONTENT_SECURITY_POLICY_MODE         "compatible" (default) or "strict". "strict"
 *                                        promotes the strict policy to the enforced one.
 *   CONTENT_SECURITY_POLICY_REPORT_ONLY  "true" sends the enforced policy in report-only
 *                                        mode instead (and suppresses the companion).
 *   CONTENT_SECURITY_POLICY_REPORTING_DISABLED
 *                                        "true" drops the report-only companion header.
 *   CONTENT_SECURITY_POLICY_REPORT_URI   default "/Security/CspReport".
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

    // The origins the app genuinely loads scripts from, replacing the blanket
    // https: source in the strict policy. Keep in step with the <script src>
    // tags in Main/index.html and Main/login.html.
    //   • googlesyndication / googletagservices / doubleclick / gstatic —
    //     AdSense's loader and the further scripts it pulls in.
    //   • *.adtrafficquality.google — SODAR, Google's ad traffic-quality probe.
    //     show_ads_impl pulls sodar2.js from ep1/ep2.adtrafficquality.google at
    //     runtime, so it appears in no markup and is easy to miss when reading
    //     the <script> tags. Same failure shape as the Cloudflare beacon below:
    //     without this entry the strict candidate reports it on every ad-bearing
    //     page load, and promoting strict to enforcing would break AdSense's
    //     invalid-traffic detection. The wildcard is deliberate — Google picks
    //     the ep* subdomain per request. The apex is NOT included because CSP
    //     wildcards do not match it and nothing is served from it.
    //   • static.zohocdn.com — the Zoho Payments checkout widget
    //     (ZohoPaymentsCheckout expects zpay-js to be present).
    //   • checkout.razorpay.com — the dormant Razorpay checkout, still shipped.
    //   • static.cloudflareinsights.com — the Cloudflare RUM/Web-Analytics beacon.
    //     It is not in any page's markup: Cloudflare injects the <script> into
    //     every proxied HTML response at the edge, so it is present in production
    //     (behind the tunnel) and absent locally. Without this entry the strict
    //     candidate reports it on every single page load, which both buries the
    //     genuine findings in the admin Alerts tab and would break the beacon the
    //     moment strict mode is promoted to enforcing.
    // Google OAuth needs no entry: the login is a server-side redirect flow,
    // not a client-side Google script. The beacon's own reporting call needs no
    // connect-src entry either — that directive allows https: in both policies.
    static STRICT_SCRIPT_ORIGINS =
    [
        "https://pagead2.googlesyndication.com",
        "https://*.googlesyndication.com",
        "https://*.googletagservices.com",
        "https://*.doubleclick.net",
        "https://*.adtrafficquality.google",
        "https://*.gstatic.com",
        "https://static.zohocdn.com",
        "https://checkout.razorpay.com",
        "https://static.cloudflareinsights.com"
    ];

    // The tightened candidate. Differs from the compatible policy ONLY in
    // script-src: no 'unsafe-inline', no 'unsafe-eval', and named origins in
    // place of blanket https:. 'wasm-unsafe-eval' and blob: stay — the
    // in-browser LLM compiles WebAssembly and spawns blob-URL workers.
    static STRICT_CONTENT_SECURITY_POLICY_DIRECTIVES =
    {
        ...SecurityHeaders.CONTENT_SECURITY_POLICY_DIRECTIVES,
        "script-src": ["'self'", "'wasm-unsafe-eval'", "blob:", ...SecurityHeaders.STRICT_SCRIPT_ORIGINS]
    };

    static DEFAULT_REPORT_URI = "/Security/CspReport";

    static STRICT_MODE = "strict";

    // Subresource extensions the report-only companion is skipped for. Only the
    // DOCUMENT's policy governs what a page may load, so a second CSP header on
    // a script, stylesheet, font or image response is inert — and at roughly
    // half a kilobyte on every asset of every cold page load, not free. ".html"
    // is deliberately absent: that IS a document.
    static SUBRESOURCE_EXTENSIONS = new Set
    ([
        "js", "mjs", "css", "map", "wasm",
        "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp",
        "woff", "woff2", "ttf", "otf", "eot",
        "mp3", "mp4", "webm", "wav", "ogg", "bin", "data", "pdf", "csv"
    ]);

    static __cachedContentSecurityPolicy = null;
    static __cachedStrictContentSecurityPolicy = null;

    static isDisabled()
    {
        return String(process.env.SECURITY_HEADERS_DISABLED || "").toLowerCase() === "true";
    }

    static isReportOnly()
    {
        return String(process.env.CONTENT_SECURITY_POLICY_REPORT_ONLY || "").toLowerCase() === "true";
    }

    static isStrictMode()
    {
        return String(process.env.CONTENT_SECURITY_POLICY_MODE || "").trim().toLowerCase() === SecurityHeaders.STRICT_MODE;
    }

    static isReportingDisabled()
    {
        return String(process.env.CONTENT_SECURITY_POLICY_REPORTING_DISABLED || "").toLowerCase() === "true";
    }

    static getReportUri()
    {
        const configured = String(process.env.CONTENT_SECURITY_POLICY_REPORT_URI || "").trim();
        return configured.length > 0 ? configured : SecurityHeaders.DEFAULT_REPORT_URI;
    }

    static hasVerbatimOverride()
    {
        const override = process.env.CONTENT_SECURITY_POLICY;
        return Boolean(override && override.trim().length > 0);
    }

    static serializeDirectives(directives)
    {
        const serializedDirectives = [];
        for (const [directiveName, sources] of Object.entries(directives))
        {
            serializedDirectives.push(`${directiveName} ${sources.join(" ")}`);
        }

        return serializedDirectives.join("; ");
    }

    /**
     * The policy that is actually ENFORCED (or, when the report-only flag is
     * set, the one sent report-only). A verbatim override always wins; failing
     * that, strict mode selects the strict policy and the default selects the
     * compatible one.
     */
    static buildContentSecurityPolicy()
    {
        if (SecurityHeaders.__cachedContentSecurityPolicy !== null)
        {
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        if (SecurityHeaders.hasVerbatimOverride())
        {
            SecurityHeaders.__cachedContentSecurityPolicy = process.env.CONTENT_SECURITY_POLICY.trim();
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        if (SecurityHeaders.isStrictMode())
        {
            SecurityHeaders.__cachedContentSecurityPolicy = SecurityHeaders.buildStrictContentSecurityPolicy();
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        SecurityHeaders.__cachedContentSecurityPolicy =
            SecurityHeaders.serializeDirectives(SecurityHeaders.CONTENT_SECURITY_POLICY_DIRECTIVES);
        return SecurityHeaders.__cachedContentSecurityPolicy;
    }

    /**
     * The strict candidate, carrying the report-uri so a browser evaluating it
     * report-only tells us what it would have blocked.
     */
    static buildStrictContentSecurityPolicy()
    {
        if (SecurityHeaders.__cachedStrictContentSecurityPolicy !== null)
        {
            return SecurityHeaders.__cachedStrictContentSecurityPolicy;
        }

        const serialized = SecurityHeaders.serializeDirectives(SecurityHeaders.STRICT_CONTENT_SECURITY_POLICY_DIRECTIVES);
        SecurityHeaders.__cachedStrictContentSecurityPolicy = `${serialized}; report-uri ${SecurityHeaders.getReportUri()}`;
        return SecurityHeaders.__cachedStrictContentSecurityPolicy;
    }

    /**
     * The strict policy to ship as a report-only companion beside the enforced
     * compatible one, or null when no companion should be sent.
     *
     * Suppressed when reporting is switched off, when strict mode is already
     * enforcing it, when the operator supplied a verbatim policy (they own the
     * policy entirely), and when the legacy report-only flag is set (that flag
     * already turns the enforced header into a report-only one, and a second
     * report-only header would simply replace it).
     */
    static buildReportOnlyCompanionPolicy()
    {
        if (SecurityHeaders.isReportingDisabled()
            || SecurityHeaders.isStrictMode()
            || SecurityHeaders.isReportOnly()
            || SecurityHeaders.hasVerbatimOverride())
        {
            return null;
        }

        return SecurityHeaders.buildStrictContentSecurityPolicy();
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

    /**
     * Whether this request is for a subresource rather than a document.
     *
     * @param {object} request the incoming request
     *
     * @returns {boolean} true when the report-only companion can be skipped
     */
    static isSubresourceRequest(request)
    {
        const rawUrl = typeof request.url === "string" ? request.url : "";
        const endpointPath = (rawUrl.split("?")[0] || "/").toLowerCase();

        const lastSegment = endpointPath.substring(endpointPath.lastIndexOf("/") + 1);
        const dotIndex = lastSegment.lastIndexOf(".");
        if (dotIndex === -1)
        {
            return false;
        }

        return SecurityHeaders.SUBRESOURCE_EXTENSIONS.has(lastSegment.substring(dotIndex + 1));
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

        // The strict candidate rides along report-only so browsers tell us what
        // it WOULD block. Report-only never blocks anything, so this cannot
        // affect functionality — it only produces the evidence needed before
        // promoting it to enforcing. Skipped on subresources, whose CSP header
        // no browser consults.
        if (!SecurityHeaders.isSubresourceRequest(request))
        {
            const reportOnlyCompanionPolicy = SecurityHeaders.buildReportOnlyCompanionPolicy();
            if (reportOnlyCompanionPolicy !== null)
            {
                response.setHeader("Content-Security-Policy-Report-Only", reportOnlyCompanionPolicy);
            }
        }
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
