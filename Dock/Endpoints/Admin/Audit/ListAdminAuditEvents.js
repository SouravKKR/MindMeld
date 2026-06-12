const AdminAuditEventQueryEngine = require("../../../Globals/Classes/Database/AdminAuditEventQueryEngine");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Audit/List
 *
 * Returns the recent admin-action audit events plus a small summary. Gated by the
 * EnsureAdmin server plugin (super-admin only).
 *
 * Query params (all optional):
 *   since=<ISO>     — only events whose occurredAt is newer
 *   outcome=<label> — restrict to a single outcome ("SUCCESS" | "FAILURE")
 *   limit=<n>
 */
async function listAdminAuditEvents(request, response)
{
    const query = (await request.getQueryParams()) || {};
    const since = typeof query.since === "string" && query.since.length > 0 ? query.since : null;
    const outcome = typeof query.outcome === "string" && query.outcome.length > 0 ? query.outcome : null;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;

    try
    {
        const events = await AdminAuditEventQueryEngine.list({ since, outcome, limit });

        const oneDayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const last24HourCount = await AdminAuditEventQueryEngine.countSince(oneDayAgoIso);

        const distinctActors = new Set(events.map((event) => event.actorUserId).filter(Boolean)).size;

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            events: events,
            summary:
            {
                shown: events.length,
                last24HourCount: last24HourCount,
                distinctActors: distinctActors
            }
        });
    }
    catch (listError)
    {
        console.error(`[ListAdminAuditEvents] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: "Failed to list admin audit events." });
    }
}

module.exports = { listAdminAuditEvents };
