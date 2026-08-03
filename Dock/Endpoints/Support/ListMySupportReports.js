const { getUser } = require("../Helpers/GetUser");
const SupportTicketQueryEngine = require("../../Globals/Classes/Database/SupportTicketQueryEngine");
const SupportTicketQuota = require("../../Globals/Classes/Support/SupportTicketQuota");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * GET /Support/MyReports
 *
 * The reporter's own history: every issue they have submitted, with the current
 * status of the ticket it was grouped onto and whatever the admin wrote when
 * closing it.
 *
 * This exists specifically so someone who left the "notify me" box unchecked can
 * still find out whether their issue was fixed. Consent to being emailed and the
 * ability to check a status are different things, and only the former is opt-in.
 *
 * Scoped entirely to the session user — the caller supplies no identifier, so
 * there is nothing here to tamper with.
 */
async function listMySupportReports(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const reports = await SupportTicketQueryEngine.listReportsForUser(user.getId());
    const quotaOutcome = await SupportTicketQuota.check(user.getId());

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        reports: reports,
        quota:
        {
            limit: quotaOutcome.limit,
            remaining: quotaOutcome.remaining,
            retryAfterSeconds: quotaOutcome.retryAfterSeconds
        }
    });
}

module.exports = { listMySupportReports };
