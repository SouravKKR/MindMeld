const RateLimitEventQueryEngine = require("../../../Globals/Classes/Database/RateLimitEventQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/RateLimits/List
 *
 * Returns the recent server-side 429 events plus a small summary. Gated by the
 * EnsureAdmin server plugin (super-admin only).
 *
 * Query params (all optional):
 *   since=<ISO>   — only events whose occurredAt is newer
 *   scope=<label> — restrict to a single scope ("PER_USER" | "OVERALL")
 *   limit=<n>
 */
async function listRateLimitEvents(request, response)
{
    const query = (await request.getQueryParams()) || {};
    const since = typeof query.since === "string" && query.since.length > 0 ? query.since : null;
    const scope = typeof query.scope === "string" && query.scope.length > 0 ? query.scope : null;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;

    try
    {
        const events = await RateLimitEventQueryEngine.list({ since, scope, limit });

        const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const last24HourCount = await RateLimitEventQueryEngine.countSince(oneDayAgoIso);

        const distinctIdentities = new Set(events.map((event) => event.identityKey)).size;

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            events: events,
            summary:
            {
                shown: events.length,
                last24HourCount: last24HourCount,
                distinctIdentities: distinctIdentities
            }
        });
    }
    catch (listError)
    {
        console.error(`[ListRateLimitEvents] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to list rate-limit events." });
    }
}

module.exports = { listRateLimitEvents };
