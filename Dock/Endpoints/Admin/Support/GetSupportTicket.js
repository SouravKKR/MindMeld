const SupportTicketQueryEngine = require("../../../Globals/Classes/Database/SupportTicketQueryEngine");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * GET /Admin/Support/Ticket?ticketId=...
 *
 * The full detail behind one row of the admin Support list: the canonical ticket,
 * every individual report that was grouped onto it, and the reporter counts the
 * admin needs before deciding on an incentive.
 *
 * Reporter emails are returned in full rather than masked — the admin is already
 * able to look any user up through the Credits and Organizations tabs, and seeing
 * who reported an issue is the point of the screen. The access is recorded either
 * way, since AdminActionAuditor is attached by the ensureAdmin gate.
 */
async function getSupportTicket(request, response)
{
    const queryParameters = await request.getQueryParams();
    const ticketId = typeof queryParameters?.ticketId === "string" ? queryParameters.ticketId.trim() : "";

    if (ticketId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const supportTicket = await SupportTicketQueryEngine.getTicket(ticketId);

    if (supportTicket === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_TICKET_NOT_FOUND });
        return;
    }

    const reports = await SupportTicketQueryEngine.listReportsForTicket(ticketId);
    const reporterSummary = await SupportTicketQueryEngine.summariseReporters(ticketId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        ticket: supportTicket.toClientJson(),
        reports: reports.map(report => report.toJson()),
        reporterCount: reporterSummary.reporterCount,
        notifyOptInCount: reporterSummary.notifyOptInCount
    });
}

module.exports = { getSupportTicket };
