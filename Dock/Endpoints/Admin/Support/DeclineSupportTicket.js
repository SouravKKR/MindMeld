const SupportTicketQueryEngine = require("../../../Globals/Classes/Database/SupportTicketQueryEngine");
const SupportAttachmentPurger = require("../../../Globals/Classes/Support/SupportAttachmentPurger");
const SupportTicketResolutionDispatcher = require("../../../Globals/Classes/Support/SupportTicketResolutionDispatcher");
const SupportTicketLimits = require("../../../Globals/Classes/Support/SupportTicketLimits");
const { supportTicketStatus } = require("../../../Globals/Enumerations/SupportTicketStatus");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/Support/Ticket/Decline
 *
 * Body: { ticketId, declineMessage? }
 *
 * Closes a ticket without a fix. The message is optional — when it is left blank
 * the reporters who opted in receive a generic explanation composed by
 * EmailSender, so a decline is never a silent dead end. No credits are granted.
 *
 * Shares the claim-then-dispatch ordering of the resolve endpoint: the atomic
 * ACTIVE-guarded flip is what makes a repeated click a 409 instead of a second
 * round of emails.
 */
async function declineSupportTicket(request, response)
{
    const body = await request.getBody();
    const ticketId = typeof body?.ticketId === "string" ? body.ticketId.trim() : "";

    if (ticketId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const declineMessage = String(body?.declineMessage ?? "").trim();

    if (declineMessage.length > SupportTicketLimits.MAXIMUM_DECLINE_MESSAGE_LENGTH)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "declineMessageTooLong", maximumLength: SupportTicketLimits.MAXIMUM_DECLINE_MESSAGE_LENGTH });
        return;
    }

    const existingTicket = await SupportTicketQueryEngine.getTicket(ticketId);

    if (existingTicket === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_TICKET_NOT_FOUND });
        return;
    }

    const reporterSummary = await SupportTicketQueryEngine.summariseReporters(ticketId);

    const claimedTicket = await SupportTicketQueryEngine.claimActiveTicket(ticketId,
    {
        status: supportTicketStatus.DECLINED,
        declinedAt: Date.now(),
        declinedByUserId: request.user ? request.user.getId() : "",
        declineMessage: declineMessage,
        creditsPerReporter: 0,
        dispatchState: { startedAt: Date.now(), completedAt: null, processedCount: 0, totalCount: reporterSummary.reporterCount }
    });

    if (claimedTicket === null)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.SUPPORT_TICKET_NOT_ACTIVE, currentStatus: existingTicket.getStatus() });
        return;
    }

    response.statusCode = httpStatus.ACCEPTED;
    response.sendJson
    ({
        success: true,
        ticket: claimedTicket.toClientJson(),
        reporterCount: reporterSummary.reporterCount,
        notifyOptInCount: reporterSummary.notifyOptInCount
    });

    SupportTicketResolutionDispatcher.dispatch(claimedTicket).catch(dispatchError =>
    {
        console.error(`[DeclineSupportTicket] Fan-out failed for ticket ${ticketId}: ${dispatchError?.message || dispatchError}`);
    });

    // Attachments exist to diagnose a live report. The ticket is now closed, so
    // purge them rather than leaving other people's screen contents on the
    // platform for the remainder of their retention window. Fire-and-forget: the
    // ticket is already settled and the response already sent, and the registry
    // backstop retries anything this misses.
    SupportAttachmentPurger.purgeForTicket(ticketId).catch(purgeError =>
    {
        console.warn(`[DeclineSupportTicket] Attachment purge failed for ticket ${ticketId}: ${purgeError?.message || purgeError}`);
    });
}

module.exports = { declineSupportTicket };
