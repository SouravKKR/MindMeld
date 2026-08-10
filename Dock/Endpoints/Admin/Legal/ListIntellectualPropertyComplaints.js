const IntellectualPropertyComplaintQueryEngine = require("../../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * GET /Admin/Legal/ListIntellectualPropertyComplaints
 *     ?includeUnverified=&includeClosed=&limit=&offset=
 *
 * The Grievance Officer's queue, ordered by deadline — which is receipt order,
 * because every deadline is a fixed offset from receipt.
 *
 * ── What the default view shows, and why ───────────────────────────────────
 *
 * By default: verified, still open. That is the set someone should work through
 * top-down. Unverified complaints are excluded from the DEFAULT view rather than
 * from the endpoint — `includeUnverified=1` returns them — because acting on an
 * unconfirmed notice means removing somebody's content on the word of a
 * correspondent who cannot be written back to, while hiding them outright would
 * conceal the fact that a complaint was received at all.
 *
 * Each row carries its computed deadlines and a plain `bOverdue` so the console
 * does not do that arithmetic itself. Two places computing when something is
 * late is two places that can disagree about it, and the record has to be the
 * one that is right.
 */
async function listIntellectualPropertyComplaints(request, response)
{
    const MAXIMUM_PAGE_SIZE = 200;
    const DEFAULT_PAGE_SIZE = 50;

    const queryParams = await request.getQueryParams();

    const requestedLimit = Number.parseInt(queryParams.limit, 10);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, MAXIMUM_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

    const requestedOffset = Number.parseInt(queryParams.offset, 10);
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0 ? requestedOffset : 0;

    const bIncludeUnverified = queryParams.includeUnverified === "1" || queryParams.includeUnverified === "true";
    const bIncludeClosed = queryParams.includeClosed === "1" || queryParams.includeClosed === "true";

    try
    {
        const queuePage = await IntellectualPropertyComplaintQueryEngine.listByDeadline
        ({
            bIncludeUnverified: bIncludeUnverified,
            bOnlyOpen: !bIncludeClosed,
            limit: limit,
            offset: offset
        });

        const nowMilliseconds = Date.now();

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            complaints: queuePage.complaints.map(complaint =>
            {
                const complaintJson = complaint.toAdminJson();

                return {
                    ...complaintJson,
                    bAcknowledgmentOverdue: complaint.getAcknowledgedAt() === null && nowMilliseconds > complaint.getAcknowledgmentDeadline(),
                    bDisposalOverdue: nowMilliseconds > complaint.getDisposalDeadline(),
                    // Null until access has actually been disabled — there is no
                    // block to expire before then, and reporting one would tell
                    // an administrator a window was running that was not.
                    bBlockWindowElapsed: complaint.getBlockExpiryDeadline() !== null && nowMilliseconds > complaint.getBlockExpiryDeadline()
                };
            }),
            totalCount: queuePage.totalCount,
            limit: limit,
            offset: offset,
            serverTime: nowMilliseconds
        });
    }
    catch (listError)
    {
        console.error(`[ListIntellectualPropertyComplaints] ${listError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: listError.message || "Failed to list intellectual-property complaints." });
    }
}

module.exports = { listIntellectualPropertyComplaints };
