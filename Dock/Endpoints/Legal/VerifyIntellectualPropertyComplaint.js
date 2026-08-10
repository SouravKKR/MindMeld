const IntellectualPropertyComplaintQueryEngine = require("../../Globals/Classes/Database/IntellectualPropertyComplaintQueryEngine");
const OtpManager = require("../../Globals/Classes/Authentication/OtpManager");
const { otpPurposes } = require("../../Globals/Enumerations/OtpPurposes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /Legal/IntellectualPropertyComplaint/Verify
 *
 * Body: { contactEmail: string, code: string }
 *
 * Confirms that whoever filed a complaint can read the address they gave for it.
 * On success the complaint becomes actionable in the admin queue and a
 * short-lived credential is returned so evidence can be attached.
 *
 * ── What this does and does not decide ─────────────────────────────────────
 *
 * It does not decide whether the complaint was received — that happened when it
 * was stored, and every deadline already runs from then. It decides whether the
 * complaint enters the queue an administrator works through, because acting on
 * an unattributable notice means removing someone's content on the word of a
 * correspondent who cannot be written back to.
 *
 * ── Why the code is checked against a PURPOSE ──────────────────────────────
 *
 * OtpManager scopes codes by purpose, and this passes the complaint purpose
 * explicitly. A sign-in code must not confirm a complaint, and — the direction
 * that actually costs something — a complaint code must not be redeemable at
 * the login endpoint, where it would become a session on an account belonging
 * to whoever owns that address.
 *
 * ── Why the response never distinguishes "no such complaint" ───────────────
 *
 * A wrong code, an expired code and an address with nothing pending all return
 * the same shape. Anything else turns this endpoint into an oracle for which
 * addresses have filed complaints against the platform, which is not something
 * a stranger should be able to enumerate.
 */
async function verifyIntellectualPropertyComplaint(request, response)
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

    const contactEmail = (typeof body?.contactEmail === "string" ? body.contactEmail.trim() : "").toLowerCase();
    const submittedCode = typeof body?.code === "string" ? body.code.trim() : "";

    if (!EMAIL_REGEX.test(contactEmail))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_EMAIL });
        return;
    }

    if (!/^\d{6}$/.test(submittedCode))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    // The code is checked FIRST, before the complaint is looked up. Reversing
    // the two would answer "there is no complaint for that address" to anyone
    // who typed six digits, which is the enumeration this endpoint is careful
    // not to offer.
    const codeOutcome = await OtpManager.verifyOtp(contactEmail, submittedCode, otpPurposes.INTELLECTUAL_PROPERTY_COMPLAINT_VERIFICATION);

    if (!codeOutcome.ok)
    {
        response.statusCode = httpStatus.BAD_REQUEST;

        const errorPayload = { error: codeOutcome.reason || ErrorCodes.INVALID_CODE };

        if (typeof codeOutcome.attemptsRemaining === "number")
        {
            errorPayload.attemptsRemaining = codeOutcome.attemptsRemaining;
        }

        response.sendJson(errorPayload);
        return;
    }

    const complaint = await IntellectualPropertyComplaintQueryEngine.findLatestUnverifiedByContactEmail(contactEmail);

    if (!complaint)
    {
        // The code was genuine but there is nothing outstanding to confirm —
        // usually a second confirmation of a complaint already verified. Not an
        // error the complainant can act on, so it is not reported as one.
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, bAlreadyVerified: true });
        return;
    }

    const verificationOutcome = await IntellectualPropertyComplaintQueryEngine.markContactVerified(complaint.getId());

    if (!verificationOutcome.verified)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, bAlreadyVerified: true });
        return;
    }

    response.sendJson
    ({
        success: true,
        bAlreadyVerified: false,
        reference: complaint.getReference(),
        complaintId: complaint.getId(),
        evidenceUploadToken: verificationOutcome.evidenceUploadToken,
        evidenceUploadTokenExpiresAt: verificationOutcome.evidenceUploadTokenExpiresAt,
        disposalDeadline: complaint.getDisposalDeadline()
    });
}

module.exports = { verifyIntellectualPropertyComplaint };
