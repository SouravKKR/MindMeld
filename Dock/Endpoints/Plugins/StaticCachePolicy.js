const { PacketronPlugin } = require("@gamiumgamers/packetron");

/**
 * Cache policy for everything served out of Dock/Static.
 *
 * The default for this tree is no-store, and that default is correct: the app's
 * own HTML and bundles are rewritten by every deploy, and packetron serves from
 * the file system with no idea how long a file stays valid. Serving a stale
 * bundle is worse than re-downloading a fresh one.
 *
 * Vendored third-party libraries are the exception. They are large — Mermaid
 * alone is ~2.5 MB, and ThirdParty/ totals ~15 MB — and they change only when
 * somebody deliberately upgrades them, which is rare and never part of a routine
 * deploy. Re-downloading them on every page load costs the user real bandwidth
 * for bytes that did not change. This mirrors the exemption /Assets already has
 * for offline-AI model shards (see the comment above `server.serve` for it in
 * Dock/index.js): large + immutable is exactly the shape that should be cached.
 *
 * Two tiers, and which one a file gets is decided by its NAME:
 *
 *   - A file whose name carries its version (`mermaid-11.4.1.min.js`) is
 *     immutable by construction. That URL can never mean anything else, because
 *     an upgrade produces a different filename and therefore a different URL.
 *     It is safe to cache for a year with no revalidation.
 *
 *   - A file without a version in its name (`chart.js`) could be replaced in
 *     place by a future upgrade, so it gets a one-day cache instead. Repeat
 *     loads still cost nothing, and an upgrade reaches every user within a day
 *     without anyone having to remember to bust a cache.
 *
 * Making immutability OPT IN via the filename is what keeps this safe. The
 * failure mode of the alternative — caching the whole tree for a year on the
 * promise that everyone remembers to rename on upgrade — is a user pinned to a
 * stale library for twelve months, with no way for the server to correct it.
 */
class StaticCachePolicy
{
    // Matched against the lower-cased request path.
    static THIRD_PARTY_PATH_PREFIX = "/thirdparty/";

    // Offline-AI model weights and the ONNX Runtime binary, served from
    // Dock/Assets rather than Dock/Static. Immutable by construction: the URL
    // embeds the model's own folder name, so an upgrade is a different folder
    // and therefore a different URL — the same opt-in reasoning the versioned
    // ThirdParty filenames use. Worth a year because the alternative is a user
    // who cleared their Cache API re-pulling most of a gigabyte.
    static IMMUTABLE_ASSET_PATH_PREFIXES = ["/assets/models/", "/assets/runtime/"];

    // Not everything under ThirdParty/ is third-party. Dock/Static/ThirdParty/
    // BrowserLlm/ also holds OUR OWN code — the inference worker, its
    // hand-mirrored protocol enums and the engine runner — which sits there for
    // one reason only: it must escape bundling and obfuscation, because it
    // imports the 6.8 MB vendor bundle that would otherwise be inlined into the
    // SPA bundle. Being in that directory says nothing about how often it
    // changes, and these three change on ordinary deploys.
    //
    // That breaks the assumption the exemption below rests on ("they change
    // only when somebody deliberately upgrades them, which is never part of a
    // routine deploy"). At one day of public caching, a fix to the engine
    // runner stayed invisible for 24 hours to browsers AND to the CDN edge,
    // which cached it and went on serving the old file to everyone — a deploy
    // that verifiably shipped and verifiably did nothing. Worse,
    // BrowserLlmWorkerProtocol.js mirrors two codegen'd enums by hand, so a
    // stale copy can silently disagree with the bundle that talks to it.
    //
    // The vendored BrowserLlm.js beside them is genuinely third-party and keeps
    // its cache — it is 6.8 MB and really does change only on an upgrade.
    static FIRST_PARTY_THIRD_PARTY_FILE_NAMES = new Set([
        "browserllmenginerunner.js",
        "browserllmworker.js",
        "browserllmworkerprotocol.js",
    ]);

    // A version embedded in the filename: "-11.4.1." or "-2.1.7-" and so on.
    // Anchored to a preceding hyphen so an ordinary dotted name like
    // "jspdf.umd.min.js" is not mistaken for a versioned one.
    static VERSIONED_FILE_NAME_PATTERN = /-\d+\.\d+(?:\.\d+)?[.\-_]/;

    static IMMUTABLE_MAX_AGE_SECONDS = 31536000;
    static REVALIDATED_MAX_AGE_SECONDS = 86400;

    static NO_STORE_CACHE_CONTROL = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";

    /**
     * Returns the Cache-Control value for a request path, or null when the path
     * should keep the no-store treatment.
     */
    static resolveCacheControl(requestUrl)
    {
        const requestPath = String(requestUrl || "").split("?")[0].toLowerCase();

        for (const immutablePrefix of StaticCachePolicy.IMMUTABLE_ASSET_PATH_PREFIXES)
        {
            if (requestPath.startsWith(immutablePrefix))
            {
                return `public, max-age=${StaticCachePolicy.IMMUTABLE_MAX_AGE_SECONDS}, immutable`;
            }
        }

        if (!requestPath.startsWith(StaticCachePolicy.THIRD_PARTY_PATH_PREFIX))
        {
            return null;
        }

        const fileName = requestPath.substring(requestPath.lastIndexOf("/") + 1);

        // First-party code that merely lives under ThirdParty/ — no-store, same
        // as the rest of the app it ships with.
        if (StaticCachePolicy.FIRST_PARTY_THIRD_PARTY_FILE_NAMES.has(fileName))
        {
            return null;
        }

        if (StaticCachePolicy.VERSIONED_FILE_NAME_PATTERN.test(fileName))
        {
            return `public, max-age=${StaticCachePolicy.IMMUTABLE_MAX_AGE_SECONDS}, immutable`;
        }

        return `public, max-age=${StaticCachePolicy.REVALIDATED_MAX_AGE_SECONDS}`;
    }
}

const staticCachePolicy = new PacketronPlugin
({
    handler: (request, response) =>
    {
        const cacheControl = StaticCachePolicy.resolveCacheControl(
            typeof request.url === "string" ? request.url : ""
        );

        if (cacheControl !== null)
        {
            response.setHeader("Cache-Control", cacheControl);
            return;
        }

        // Same headers NoCache sets. Pragma/Expires are there for the proxies and
        // intermediaries that predate Cache-Control and would otherwise apply
        // their own heuristic freshness to a response that must never be reused.
        response.setHeader("Cache-Control", StaticCachePolicy.NO_STORE_CACHE_CONTROL);
        response.setHeader("Pragma", "no-cache");
        response.setHeader("Expires", "0");
        response.setHeader("Surrogate-Control", "no-store");
    }
});

module.exports = { staticCachePolicy, StaticCachePolicy };
