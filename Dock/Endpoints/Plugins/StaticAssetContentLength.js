const { PacketronPlugin } = require("@gamiumgamers/packetron");
const fileSystem = require("fs");
const path = require("path");

/**
 * Declares Content-Length on the files served out of Dock/Assets.
 *
 * The static route streams these and never sets a length, so every response
 * goes out as `Transfer-Encoding: chunked`. Nothing is broken by that in
 * itself, and it is invisible for a stylesheet — but these are the on-device
 * AI model weights, where three things follow from it:
 *
 *   - The download reports no progress. Transformers.js only populates the
 *     `total` on its progress callback when the response declares a length, so
 *     the weights file contributes bytes to the numerator and nothing to the
 *     denominator. The bar reaches 100% on the first chunk and stays there for
 *     the rest of a multi-hundred-megabyte download, which reads as a hang.
 *
 *   - ONNX Runtime cannot size its buffer up front — it logs "Unable to
 *     determine content-length from response headers. Will expand buffer when
 *     needed" and then repeatedly reallocates and copies a buffer that ends up
 *     hundreds of megabytes large, on a machine already close to its limit.
 *
 *   - Cloudflare will not cache a chunked response: these answer
 *     `cf-cache-status: DYNAMIC` despite being marked immutable for a year, so
 *     every device on every network pulls the whole model from the origin.
 *
 * The length is read from the file itself rather than trusted from anywhere
 * else, so it cannot drift from what is actually sent.
 */
class StaticAssetContentLength
{
    // Dock/Endpoints/Plugins → Dock/Assets.
    static ASSETS_DIRECTORY = path.join(__dirname, "..", "..", "Assets");

    static ASSETS_PATH_PREFIX = "/Assets/";

    /**
     * Maps a request path to the file it is served from, or null when the path
     * is not an asset request or escapes the assets directory.
     *
     * The containment check is not a formality. The path arrives from the
     * network and is joined onto a real directory, so without it a request
     * carrying `..` segments would have this stat — and report the size of —
     * a file outside the tree. It cannot serve that file (the static route
     * decides what is sent), but confirming existence and size of arbitrary
     * paths is itself worth denying.
     */
    static resolveFilePath(requestUrl)
    {
        const requestPath = String(requestUrl || "").split("?")[0];

        if (!requestPath.startsWith(StaticAssetContentLength.ASSETS_PATH_PREFIX))
        {
            return null;
        }

        let decodedPath;
        try
        {
            decodedPath = decodeURIComponent(requestPath.substring(StaticAssetContentLength.ASSETS_PATH_PREFIX.length));
        }
        catch (decodeError)
        {
            return null;
        }

        if (decodedPath.length === 0 || decodedPath.includes("\0"))
        {
            return null;
        }

        const candidatePath = path.resolve(StaticAssetContentLength.ASSETS_DIRECTORY, decodedPath);
        const containingDirectory = path.resolve(StaticAssetContentLength.ASSETS_DIRECTORY) + path.sep;

        if (!candidatePath.startsWith(containingDirectory))
        {
            return null;
        }

        return candidatePath;
    }
}

const staticAssetContentLength = new PacketronPlugin
({
    handler: (request, response) =>
    {
        const filePath = StaticAssetContentLength.resolveFilePath(
            typeof request.url === "string" ? request.url : ""
        );

        if (filePath === null)
        {
            return;
        }

        try
        {
            const fileStatistics = fileSystem.statSync(filePath);
            if (fileStatistics.isFile())
            {
                response.setHeader("Content-Length", String(fileStatistics.size));
            }
        }
        catch (statError)
        {
            // A missing file is the static route's 404 to report, not this
            // plugin's problem — it simply declares nothing and steps aside.
        }
    }
});

module.exports = { staticAssetContentLength, StaticAssetContentLength };
