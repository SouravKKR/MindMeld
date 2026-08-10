const IntellectualPropertyComplaintQueryEngine = require("../../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const { intellectualPropertyComplaintStatus } = require("../../../Globals/Enumerations/IntellectualPropertyComplaintStatus");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

const VALID_STATUS_VALUES = new Set(Object.values(intellectualPropertyComplaintStatus));

/**
 * POST /Admin/Legal/UpdateIntellectualPropertyComplaintStatus
 *
 * Body: { complaintId: string, status: number, note?: string }
 *
 * Appends one status event to a complaint. There is no edit and no delete, here
 * or anywhere else — see IntellectualPropertyComplaintQueryEngine for why the
 * whole collection is append-only.
 *
 * ── The one status with a legal consequence ────────────────────────────────
 *
 * ACCESS_DISABLED engages the twenty-one-day window in Section 52(1)(c) of the
 * Copyright Act read with Rule 75 of the Copyright Rules — the period during
 * which access stays blocked pending a court order, after which it may be
 * restored. This event is what makes the window REAL (there is nothing to
 * restore before it), but the window itself is measured from receipt of the
 * complaint, because that is the complainant's window and the statute starts it
 * when they used it. That arithmetic lives on the record
 * (IntellectualPropertyComplaint.getBlockExpiryDeadline) so the queue, the
 * sweeper and Clause 19.5 of the Terms cannot disagree about the date.
 *
 * A consequence worth stating: disabling access late shortens the remaining
 * block, and can even land it in the past. That is the correct reading — the
 * complainant's twenty-one days do not restart because the platform was slow.
 *
 * Both the actor and their email are recorded on the event. The email is
 * denormalised deliberately: an admin account can be closed, and a legal record
 * naming only a user id that no longer resolves to anyone has quietly lost the
 * one fact it was keeping.
 */
async function updateIntellectualPropertyComplaintStatus(request, response)
{
    const requester = request.user;

    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY });
        return;
    }

    const complaintId = typeof body?.complaintId === "string" ? body.complaintId.trim() : "";
    const status = Number(body?.status);
    const note = typeof body?.note === "string" ? body.note.trim() : "";

    if (complaintId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "complaintId" });
        return;
    }

    if (!Number.isInteger(status) || !VALID_STATUS_VALUES.has(status))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "status" });
        return;
    }

    // RECEIVED and CONTACT_VERIFIED are written by the system at the moment the
    // things they describe actually happen. Letting an administrator post them
    // by hand would allow the record to claim a complaint was received or
    // confirmed at a time it was not — which is the single thing a register
    // like this exists to be trusted about.
    if (status === intellectualPropertyComplaintStatus.RECEIVED || status === intellectualPropertyComplaintStatus.CONTACT_VERIFIED)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "systemOwnedStatus" });
        return;
    }

    const complaint = await IntellectualPropertyComplaintQueryEngine.findById(complaintId);

    if (!complaint)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.COMPLAINT_NOT_FOUND });
        return;
    }

    // Disposing of a complaint means removing content or refusing to, on the
    // strength of what a stranger typed into a form. The confirmation is the
    // only thing tying that form to a person who can be written to, so it is a
    // precondition for the two terminal outcomes rather than a nicety.
    const bTerminalStatus = status === intellectualPropertyComplaintStatus.ACTIONED
        || status === intellectualPropertyComplaintStatus.REJECTED
        || status === intellectualPropertyComplaintStatus.ACCESS_DISABLED;

    if (bTerminalStatus && !complaint.getContactVerified())
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.COMPLAINT_NOT_VERIFIED });
        return;
    }

    const bAppended = await IntellectualPropertyComplaintQueryEngine.appendStatusEvent(complaintId,
    {
        status: status,
        note: note,
        actorUserId: requester.getId(),
        actorEmail: (requester.getAdditionalData() || {}).email || ""
    });

    if (!bAppended)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.COMPLAINT_NOT_FOUND });
        return;
    }

    const updatedComplaint = await IntellectualPropertyComplaintQueryEngine.findById(complaintId);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, complaint: updatedComplaint ? updatedComplaint.toAdminJson() : null });
}

module.exports = { updateIntellectualPropertyComplaintStatus };
