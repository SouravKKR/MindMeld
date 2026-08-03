const SupportTicketQueryEngine = require("../../../Globals/Classes/Database/SupportTicketQueryEngine");
const SupportAttachmentPurger = require("../../../Globals/Classes/Support/SupportAttachmentPurger");
const SupportTicketResolutionDispatcher = require("../../../Globals/Classes/Support/SupportTicketResolutionDispatcher");
const SupportTicketLimits = require("../../../Globals/Classes/Support/SupportTicketLimits");
const { supportTicketStatus } = require("../../../Globals/Enumerations/SupportTicketStatus");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/Support/Ticket/Resolve
 *
 * Body: { ticketId, resolutionMessage, creditsPerReporter }
 *
 * Closes a ticket as fixed and hands it to the resolution dispatcher, which
 * credits every reporter and writes to the ones who asked to hear back.
 *
 * The ordering here is the whole safety story. The status flip happens FIRST, as
 * a single findOneAndUpdate guarded on the ticket still being ACTIVE, and only a
 * successful claim starts the fan-out. A double-clicked Resolve button therefore
 * has its second call match nothing and return 409, rather than launching a second
 * round of credit grants and emails. Credits are never granted before the ticket
 * is claimed.
 */
async function resolveSupportTicket(request, response)
{
    const body = await request.getBody();
    const ticketId = typeof body?.ticketId === "string" ? body.ticketId.trim() : "";

    if (ticketId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_ID });
        return;
    }

    const resolutionMessage = String(body?.resolutionMessage ?? "").trim();

    if (resolutionMessage.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS, reason: "resolutionMessage" });
        return;
    }

    if (resolutionMessage.length > SupportTicketLimits.MAXIMUM_RESOLUTION_MESSAGE_LENGTH)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "resolutionMessageTooLong", maximumLength: SupportTicketLimits.MAXIMUM_RESOLUTION_MESSAGE_LENGTH });
        return;
    }

    const creditsPerReporter = Number(body?.creditsPerReporter ?? 0);

    if (!Number.isFinite(creditsPerReporter) || creditsPerReporter < 0 || creditsPerReporter > SupportTicketLimits.MAXIMUM_CREDITS_PER_REPORTER)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "creditsPerReporter", maximumAmount: SupportTicketLimits.MAXIMUM_CREDITS_PER_REPORTER });
        return;
    }

    const existingTicket = await SupportTicketQueryEngine.getTicket(ticketId);

    if (existingTicket === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUPPORT_TICKET_NOT_FOUND });
        return;
    }

    // Counted before the claim so the admin's confirmation reflects the reporters
    // the fan-out is actually about to reach.
    const reporterSummary = await SupportTicketQueryEngine.summariseReporters(ticketId);

    const claimedTicket = await SupportTicketQueryEngine.claimActiveTicket(ticketId,
    {
        status: supportTicketStatus.RESOLVED,
        resolvedAt: Date.now(),
        resolvedByUserId: request.user ? request.user.getId() : "",
        resolutionMessage: resolutionMessage,
        creditsPerReporter: creditsPerReporter,
        dispatchState: { startedAt: Date.now(), completedAt: null, processedCount: 0, totalCount: reporterSummary.reporterCount }
    });

    if (claimedTicket === null)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.SUPPORT_TICKET_NOT_ACTIVE, currentStatus: existingTicket.getStatus() });
        return;
    }

    // Answered before the fan-out. Hundreds of reporters means hundreds of SES
    // sends, which cannot fit inside a request; the admin sees the counts and the
    // dispatch state updates as it progresses.
    response.statusCode = httpStatus.ACCEPTED;
    response.sendJson
    ({
        success: true,
        ticket: claimedTicket.toClientJson(),
        reporterCount: reporterSummary.reporterCount,
        notifyOptInCount: reporterSummary.notifyOptInCount,
        totalCreditsToGrant: Number((creditsPerReporter * reporterSummary.reporterCount).toFixed(4))
    });

    SupportTicketResolutionDispatcher.dispatch(claimedTicket).catch(dispatchError =>
    {
        // Left with completedAt still null so the boot reconciler finishes it.
        console.error(`[ResolveSupportTicket] Fan-out failed for ticket ${ticketId}: ${dispatchError?.message || dispatchError}`);
    });

    // Attachments exist to diagnose a live report. The ticket is now closed, so
    // purge them rather than leaving other people's screen contents on the
    // platform for the remainder of their retention window. Fire-and-forget: the
    // ticket is already settled and the response already sent, and the registry
    // backstop retries anything this misses.
    SupportAttachmentPurger.purgeForTicket(ticketId).catch(purgeError =>
    {
        console.warn(`[ResolveSupportTicket] Attachment purge failed for ticket ${ticketId}: ${purgeError?.message || purgeError}`);
    });

}

module.exports = { resolveSupportTicket };
