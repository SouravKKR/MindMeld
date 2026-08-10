const IntellectualPropertyComplaintQueryEngine = require("../../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const ComplaintTargetResolver = require("../../../Globals/Classes/Content/ComplaintTargetResolver");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/Legal/ResolveIntellectualPropertyComplaintTargets
 *
 * Body: { complaintId: string, bRecordResolvedHashes?: boolean }
 *
 * Turns one complaint into the list of content hashes an administrator could
 * action, and hands back the exact `contentHash` + `noticeReference` pair each
 * one would need at /Admin/Content/Takedown.
 *
 * ── This endpoint removes nothing ──────────────────────────────────────────
 *
 * It reads and it suggests. The administrator then runs the takedown dry run
 * against a candidate they picked, reads the counts, and only then actions it.
 * Keeping the human step is not caution for its own sake: the strongest signal
 * this resolver ever has for a complaint that named nothing is a substring match
 * on a file name, and a takedown crosses the tenant boundary and cannot be
 * undone.
 *
 * ── noticeReference ────────────────────────────────────────────────────────
 *
 * Pre-built here rather than typed by the administrator, so the entry in the
 * takedown register points back at the complaint that prompted it. A register
 * whose references are free text is a register you cannot join to anything —
 * which is precisely the question ("on whose notice?") it exists to answer.
 *
 * `bRecordResolvedHashes` writes the candidate hashes onto the complaint. Worth
 * doing once the administrator is confident, because the complaint should end up
 * carrying what it was resolved to; left off by default so an exploratory
 * lookup does not stamp guesses onto a legal record.
 */
async function resolveIntellectualPropertyComplaintTargets(request, response)
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

    if (complaintId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_BODY, reason: "complaintId" });
        return;
    }

    const complaint = await IntellectualPropertyComplaintQueryEngine.findById(complaintId);

    if (!complaint)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.COMPLAINT_NOT_FOUND });
        return;
    }

    try
    {
        const resolution = await ComplaintTargetResolver.resolve(complaint);
        const noticeReference = buildNoticeReference(complaint);

        if (body?.bRecordResolvedHashes === true && resolution.candidates.length > 0)
        {
            await IntellectualPropertyComplaintQueryEngine.addResolvedContentHashes(
                complaint.getId(),
                resolution.candidates.map(candidate => candidate.contentHash));
        }

        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            complaintId: complaint.getId(),
            reference: complaint.getReference(),
            // Carried through verbatim so the administrator judges the candidates
            // against what the complainant actually wrote, not against a summary
            // of it.
            workDescription: complaint.getWorkDescription(),
            locationDescription: complaint.getLocationDescription(),
            noticeReference: noticeReference,
            candidates: resolution.candidates,
            byEntityCount: resolution.byEntityCount,
            bySearchCount: resolution.bySearchCount,
            searchTerms: ComplaintTargetResolver.extractSearchTerms(complaint.getWorkDescription()),
            // Stated rather than implied. A console that showed an empty list
            // with no explanation would read as "there is nothing here", when
            // the honest reading is "this complaint did not name anything and
            // its description did not match a document we hold".
            bResolvedNothing: resolution.candidates.length === 0
        });
    }
    catch (resolutionError)
    {
        console.error(`[ResolveIntellectualPropertyComplaintTargets] ${resolutionError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: resolutionError.message || "Failed to resolve complaint targets." });
    }
}

/**
 * The string that goes into the takedown register's noticeReference field.
 *
 * Carries the complaint reference and the complainant, because those two
 * together are what makes a register entry answerable months later without
 * having to open anything else.
 *
 * @param {import("../../../Globals/Model/IntellectualPropertyComplaint")} complaint
 * @returns {string}
 */
function buildNoticeReference(complaint)
{
    const complainantName = complaint.getComplainantName().length > 0 ? complaint.getComplainantName() : "unnamed complainant";
    return `${complaint.getReference()} — IP complaint from ${complainantName} <${complaint.getContactEmail()}>`;
}

module.exports = { resolveIntellectualPropertyComplaintTargets, buildNoticeReference };
