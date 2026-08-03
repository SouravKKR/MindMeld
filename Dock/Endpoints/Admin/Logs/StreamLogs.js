const LogTailQueryEngine = require("../../../Globals/Classes/Logging/LogTailQueryEngine");
const LogFormatter = require("../../../Globals/Classes/Logging/LogFormatter");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Logs/Stream?levels&categories&search
 *
 * Server-Sent-Events live tail of the central log. Reuses the same chunked
 * streaming primitive AskAI uses (writeHead + flushHeaders + incremental write).
 * The stream is fed by polling logEvents (LogTailQueryEngine) ~1s, so it surfaces
 * entries from EVERY service — Dock, Agent and burst-virtual-machine workers —
 * because they all land in the same collection. Filters are applied server-side so
 * only matching entries are pushed.
 */

const POLL_INTERVAL_MILLISECONDS = 1000;
const HEARTBEAT_INTERVAL_MILLISECONDS = 15000;
const MAXIMUM_SESSION_MILLISECONDS = 30 * 60 * 1000;
const MAXIMUM_CONCURRENT_STREAMS = 8;

let activeStreamCount = 0;

function parseIntegerList(rawValue)
{
    if (typeof rawValue !== "string" || rawValue.trim().length === 0)
    {
        return null;
    }
    const values = rawValue.split(",").map(part => Number(part.trim())).filter(Number.isInteger);
    return values.length > 0 ? values : null;
}

async function streamLogs(request, response)
{
    if (activeStreamCount >= MAXIMUM_CONCURRENT_STREAMS)
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: "TOO_MANY_LOG_STREAMS" });
        return;
    }
    activeStreamCount++;

    const queryParameters = await request.getQueryParams();
    const levels = parseIntegerList(queryParameters.levels);
    const categories = parseIntegerList(queryParameters.categories);
    const search = typeof queryParameters.search === "string" ? queryParameters.search : null;

    response.writeHead(httpStatus.OK,
    {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
    });
    if (typeof response.flushHeaders === "function")
    {
        response.flushHeaders();
    }

    // Start from "now" so the live tail shows only entries that arrive from here on.
    let sinceDate = new Date();
    let bClosed = false;
    let bPolling = false;

    const poll = async () =>
    {
        if (bClosed || bPolling)
        {
            return;
        }
        bPolling = true;
        try
        {
            const entries = await LogTailQueryEngine.fetchSince(sinceDate, { levels, categories, search }, 200);
            for (const entry of entries)
            {
                const payload = { formatted: LogFormatter.formatLine(entry), level: entry.level, entry: entry };
                response.write(`data: ${JSON.stringify(payload)}\n\n`);

                const entryTime = new Date(entry.timestamp);
                if (!Number.isNaN(entryTime.getTime()) && entryTime > sinceDate)
                {
                    sinceDate = entryTime;
                }
            }
        }
        catch (pollError)
        {
            // Transient — keep the stream open and retry next tick.
        }
        finally
        {
            bPolling = false;
        }
    };

    const pollTimer = setInterval(poll, POLL_INTERVAL_MILLISECONDS);
    const heartbeatTimer = setInterval(() =>
    {
        if (bClosed)
        {
            return;
        }
        try { response.write(": keep-alive\n\n"); } catch (writeError) { }
    }, HEARTBEAT_INTERVAL_MILLISECONDS);

    let sessionTimer = null;

    const cleanup = () =>
    {
        if (bClosed)
        {
            return;
        }
        bClosed = true;
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        if (sessionTimer)
        {
            clearTimeout(sessionTimer);
        }
        activeStreamCount = Math.max(0, activeStreamCount - 1);
        try { response.end(); } catch (endError) { }
    };

    sessionTimer = setTimeout(cleanup, MAXIMUM_SESSION_MILLISECONDS);

    request.on("close", cleanup);
    if (typeof response.on === "function")
    {
        response.on("close", cleanup);
    }

    // Immediate first poll so the client isn't blank for a second.
    poll();
}

module.exports = { streamLogs };
