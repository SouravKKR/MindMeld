const IntellectualPropertyComplaint = require("../../Globals/Model/IntellectualPropertyComplaint");
const IntellectualPropertyComplaintQueryEngine = require("../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const IntellectualPropertyComplaintConstants = require("../../Globals/Constants/IntellectualPropertyComplaintConstants");
const PublicComplaintRateLimit = require("../../Globals/Classes/Support/PublicComplaintRateLimit");
const ComplaintAcknowledger = require("../../Globals/Classes/Legal/ComplaintAcknowledger");
const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");
const { otpPurposes } = require("../../Globals/Enumerations/OtpPurposes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /Legal/IntellectualPropertyComplaint
 *
 * Body: { complainantName, contactEmail, capacityStatement, workDescription,
 *         locationDescription, deckId?, paidDeckId?, studyMaterialId?,
 *         bGoodFaithStatement, bAccuracyStatement }
 *
 * The public channel a rightsholder uses to tell the platform that content on it
 * infringes their work. UNAUTHENTICATED, and that is the point: the person most
 * likely to need it has never had an account and never will, and the Terms
 * (Clause 19.3) say so out loud.
 *
 * ── FORM FIRST, PERSIST, THEN VERIFY ───────────────────────────────────────
 *
 * The order below is the whole design. The complaint is written to the database
 * BEFORE the contact address has been confirmed, and `receivedAt` is stamped
 * then. Only afterwards is a confirmation code issued.
 *
 * Doing it the other way round — confirm, then accept the complaint — reads as
 * more careful and is worse in every way that matters. It loses everything the
 * complainant typed if they close the tab, never see the email, or mistype the
 * code; and it lets the platform's own slowness at sending an email move the
 * start of a deadline it has published. A complaint that arrives at 09:00 was
 * made at 09:00. The confirmation decides whether it becomes ACTIONABLE, not
 * whether it was heard.
 *
 * The code is issued inline, after the insert has succeeded, so nothing the
 * complainant typed can be lost to an email failure either. If the send fails
 * the complaint stands and the response says the code did not go out.
 *
 * ── ALWAYS 202 ─────────────────────────────────────────────────────────────
 *
 * Over the rate limit, the complaint is still stored and still acknowledged; it
 * is marked instead. See PublicComplaintRateLimit for why refusing would be the
 * wrong trade. The one thing withheld past the ceiling is the outbound
 * confirmation email, because that is the part that can be aimed at somebody
 * else's inbox.
 */
async function submitIntellectualPropertyComplaint(request, response)
{
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

    const complainantName = readTrimmedString(body?.complainantName);
    const contactEmail = readTrimmedString(body?.contactEmail).toLowerCase();
    const capacityStatement = readTrimmedString(body?.capacityStatement);
    const workDescription = readTrimmedString(body?.workDescription);
    const locationDescription = readTrimmedString(body?.locationDescription);

    if (complainantName.length === 0 || complainantName.length > IntellectualPropertyComplaintConstants.COMPLAINANT_NAME_MAXIMUM_LENGTH)
    {
        respondWithFieldError(response, "complainantName");
        return;
    }

    if (!EMAIL_REGEX.test(contactEmail) || contactEmail.length > IntellectualPropertyComplaintConstants.CONTACT_EMAIL_MAXIMUM_LENGTH)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_EMAIL });
        return;
    }

    if (capacityStatement.length === 0 || capacityStatement.length > IntellectualPropertyComplaintConstants.CAPACITY_STATEMENT_MAXIMUM_LENGTH)
    {
        respondWithFieldError(response, "capacityStatement");
        return;
    }

    // Both descriptions carry a floor as well as a ceiling. "Copied" is not a
    // description of a work and "on your site" is not a location; a complaint
    // that says only those cannot be acted on, and accepting it would start a
    // fifteen-day clock on something nobody can resolve.
    if (workDescription.length < IntellectualPropertyComplaintConstants.WORK_DESCRIPTION_MINIMUM_LENGTH
        || workDescription.length > IntellectualPropertyComplaintConstants.WORK_DESCRIPTION_MAXIMUM_LENGTH)
    {
        respondWithFieldError(response, "workDescription", IntellectualPropertyComplaintConstants.WORK_DESCRIPTION_MINIMUM_LENGTH);
        return;
    }

    if (locationDescription.length < IntellectualPropertyComplaintConstants.LOCATION_DESCRIPTION_MINIMUM_LENGTH
        || locationDescription.length > IntellectualPropertyComplaintConstants.LOCATION_DESCRIPTION_MAXIMUM_LENGTH)
    {
        respondWithFieldError(response, "locationDescription", IntellectualPropertyComplaintConstants.LOCATION_DESCRIPTION_MINIMUM_LENGTH);
        return;
    }

    // Clause 19.4(e) and (f). These are the two statements that make the
    // difference between a complaint and an opinion, and Section 52(1)(c)
    // relief rests on them having been made.
    if (body?.bGoodFaithStatement !== true || body?.bAccuracyStatement !== true)
    {
        respondWithFieldError(response, "statements");
        return;
    }

    const sourceIpAddress = await resolveClientIpAddress(request);
    const rateLimitOutcome = await PublicComplaintRateLimit.evaluate(contactEmail, sourceIpAddress);

    const complaint = new IntellectualPropertyComplaint
    ({
        complainantName: complainantName,
        contactEmail: contactEmail,
        capacityStatement: capacityStatement,
        workDescription: workDescription,
        locationDescription: locationDescription,
        deckId: readTrimmedString(body?.deckId),
        paidDeckId: readTrimmedString(body?.paidDeckId),
        studyMaterialId: readTrimmedString(body?.studyMaterialId),
        bGoodFaithStatement: true,
        bAccuracyStatement: true,
        bContactVerified: false,
        bRateLimitFlagged: rateLimitOutcome.bFlagged,
        sourceIpAddress: sourceIpAddress,
        receivedAt: Date.now()
    });

    const insertOutcome = await IntellectualPropertyComplaintQueryEngine.insert(complaint);

    if (!insertOutcome.saved)
    {
        // The one failure that IS reported as a failure. Everything else about
        // this endpoint is written so a complainant is never told their notice
        // was refused — but if it was not stored, saying otherwise would be a
        // lie with a legal deadline attached to it.
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.DB_SAVE_FAILED });
        return;
    }

    // The 24-hour acknowledgment, fired off the successful insert. Awaited only
    // far enough to know whether to keep the response honest about it; it never
    // fails the submission.
    const acknowledgmentSent = await ComplaintAcknowledger.acknowledge(complaint);

    let bVerificationCodeSent = false;

    if (!rateLimitOutcome.bFlagged)
    {
        try
        {
            const codeOutcome = await OtpManager.requestOtp(contactEmail, otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION);
            bVerificationCodeSent = codeOutcome.ok === true;
        }
        catch (codeError)
        {
            console.error(`[SubmitIntellectualPropertyComplaint] Could not send the confirmation code for ${complaint.getReference()}: ${codeError?.message || codeError}`);
        }
    }

    response.statusCode = httpStatus.ACCEPTED;
    response.sendJson
    ({
        success: true,
        ...complaint.toComplainantJson(),
        bAcknowledgmentSent: acknowledgmentSent,
        bVerificationCodeSent: bVerificationCodeSent
    });
}

/**
 * @param {*} value
 * @returns {string}
 */
function readTrimmedString(value)
{
    return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {object} response
 * @param {string} fieldName
 * @param {number|null} minimumLength
 */
function respondWithFieldError(response, fieldName, minimumLength = null)
{
    response.statusCode = httpStatus.BAD_REQUEST;

    const errorPayload = { error: ErrorCodes.INVALID_BODY, reason: fieldName };

    if (minimumLength !== null)
    {
        errorPayload.minimumLength = minimumLength;
    }

    response.sendJson(errorPayload);
}

/**
 * The submitting network address, matching how every rate-limit plugin resolves
 * it so the two agree about who a source is.
 *
 * @param {object} request
 * @returns {Promise<string>}
 */
async function resolveClientIpAddress(request)
{
    try
    {
        return (await request.getIp()) || "unknown";
    }
    catch (ipLookupError)
    {
        return (request.socket && request.socket.remoteAddress) || "unknown";
    }
}

module.exports = { submitIntellectualPropertyComplaint };
