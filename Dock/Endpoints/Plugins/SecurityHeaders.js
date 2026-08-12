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
 * ── Two policies, and which one is enforced ───────────────────────────────
 *
 * CogniumLearn embeds third parties that are hostile to a nonce/hash policy:
 * the Razorpay checkout widget, Google OAuth, and in-browser
 * LLMs (WebLLM / Transformers.js) that compile WebAssembly, spawn blob-URL
 * workers and stream model shards. The Web Components render inline styles
 * throughout. Both policies below therefore lock the high-value, no-risk
 * directives (object-src none, base-uri self, frame-ancestors self,
 * form-action) and both keep 'unsafe-inline' in style-src — the Web Components
 * genuinely need it, and inline style is a far smaller risk than inline script.
 *
 * They differ in script-src, and ONLY in script-src:
 *
 *   STRICT (enforced by default) drops 'unsafe-inline' and 'unsafe-eval' and
 *   replaces the blanket https: source with an explicit allow-list of the
 *   origins the app actually loads scripts from. This is the policy that
 *   satisfies the handbook's B4 control, because it is the only one of the two
 *   that actually BLOCKS an injected <script> on a page where a payment is
 *   taken. Both removals are safe for first-party code: neither app shell
 *   contains a single inline <script> or inline event handler (every script is
 *   an external src), and the only Function-constructor call in the bundled
 *   stack is a `typeof globalThis === "object" ? … : Function("return this")()`
 *   fallback that no browser capable of running this app ever reaches.
 *   'wasm-unsafe-eval' and blob: stay, for the in-browser LLM.
 *
 *   COMPATIBLE is the permissive predecessor: script-src allows
 *   'unsafe-inline', 'unsafe-eval' and any https: origin. It blocks no injected
 *   script at all, so it is NOT the default — it survives solely as a one
 *   variable escape hatch (CONTENT_SECURITY_POLICY_MODE=compatible) for an
 *   operator who finds a third party breaking under strict and needs the site
 *   working again while they investigate. When it is selected, the strict
 *   policy rides along as Content-Security-Policy-Report-Only so the evidence
 *   needed to get back to strict keeps accumulating.
 *
 * The enforced strict policy carries `report-uri` too, so promotion does not
 * blind the operator: violations keep landing in the admin Alerts tab through
 * /Security/CspReport whichever mode is selected. What cannot be verified from
 * source alone is whether a remote third party injects
 * inline script at runtime — that is exactly what those reports answer, and the
 * escape hatch is what makes acting on the answer a config change rather than a
 * deploy.
 *
 * Environment overrides (all optional):
 *   SECURITY_HEADERS_DISABLED            "true" disables the plugin entirely.
 *   CONTENT_SECURITY_POLICY              full verbatim policy string (replaces the default,
 *                                        and suppresses the report-only companion — an
 *                                        operator supplying a policy owns it entirely).
 *   CONTENT_SECURITY_POLICY_MODE         "strict" (default) or "compatible". "compatible"
 *                                        demotes the enforced policy to the permissive one
 *                                        and sends strict as a report-only companion.
 *   CONTENT_SECURITY_POLICY_REPORT_ONLY  "true" sends the enforced policy in report-only
 *                                        mode instead (and suppresses the companion).
 *   CONTENT_SECURITY_POLICY_REPORTING_DISABLED
 *                                        "true" drops the report-only companion header.
 *   CONTENT_SECURITY_POLICY_REPORT_URI   default "/Security/CspReport".
 *   REFERRER_POLICY                      default "strict-origin-when-cross-origin".
 *   PERMISSIONS_POLICY                   default denies payment/geolocation/usb/serial/
 *                                        bluetooth/midi/sensors/interest-cohort.
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

    // Powerful browser features the app never uses. Denying them shrinks what
    // injected script can reach — notably payment, which would otherwise let a
    // skimmer invoke the Payment Request API from our origin. Features the app
    // DOES use are deliberately absent from this list rather than set to
    // 'self', so nothing here can break them: microphone and camera stay
    // unlisted for future capture features, and fullscreen is left alone for
    // the image viewer and mock-test surfaces.
    static DEFAULT_PERMISSIONS_POLICY = [
        "payment=()",
        "geolocation=()",
        "usb=()",
        "serial=()",
        "bluetooth=()",
        "midi=()",
        "magnetometer=()",
        "gyroscope=()",
        "accelerometer=()",
        "interest-cohort=()"
    ].join(", ");

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
    //   • checkout.razorpay.com — the Razorpay Standard Checkout widget, the
    //     only payment script the app loads.
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
    static COMPATIBLE_MODE = "compatible";

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

    /**
     * The escape hatch, and the ONLY way to stop enforcing the strict policy
     * short of a verbatim override. Anything other than an explicit
     * "compatible" — unset, empty, "strict", a typo — leaves strict enforced,
     * so a mangled value fails towards the safer policy rather than away from
     * it.
     */
    static isCompatibleMode()
    {
        return String(process.env.CONTENT_SECURITY_POLICY_MODE || "").trim().toLowerCase() === SecurityHeaders.COMPATIBLE_MODE;
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
     * that, compatible mode selects the permissive policy and the default
     * selects the strict one.
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

        if (SecurityHeaders.isCompatibleMode())
        {
            SecurityHeaders.__cachedContentSecurityPolicy =
                SecurityHeaders.serializeDirectives(SecurityHeaders.CONTENT_SECURITY_POLICY_DIRECTIVES);
            return SecurityHeaders.__cachedContentSecurityPolicy;
        }

        SecurityHeaders.__cachedContentSecurityPolicy = SecurityHeaders.buildStrictContentSecurityPolicy();
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
     * one, or null when no companion should be sent.
     *
     * Only relevant while the escape hatch is pulled: in the default strict
     * mode the enforced header IS the strict policy and already carries the
     * report-uri, so a companion would be a duplicate. In compatible mode the
     * companion is what keeps the evidence flowing towards getting back to
     * strict.
     *
     * Suppressed when reporting is switched off, when the operator supplied a
     * verbatim policy (they own the policy entirely), and when the legacy
     * report-only flag is set (that flag already turns the enforced header into
     * a report-only one, and a second report-only header would simply replace
     * it).
     */
    static buildReportOnlyCompanionPolicy()
    {
        if (SecurityHeaders.isReportingDisabled()
            || !SecurityHeaders.isCompatibleMode()
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

        // Only when the compatible escape hatch is pulled: the strict policy
        // rides along report-only so browsers keep telling us what it WOULD
        // block, which is the evidence needed to get back to enforcing it.
        // Report-only never blocks anything, so this cannot affect
        // functionality. Skipped on subresources, whose CSP header no browser
        // consults.
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
        response.setHeader("Permissions-Policy", process.env.PERMISSIONS_POLICY || SecurityHeaders.DEFAULT_PERMISSIONS_POLICY);

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
