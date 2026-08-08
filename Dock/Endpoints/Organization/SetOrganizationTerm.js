const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationCreditLedger = require("../../Globals/Classes/Organization/OrganizationCreditLedger");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Organizations/SetTerm  (super-admin)
 *
 * Moves an organization's contract term, and brings its credit pool into line
 * with the term in the same request.
 *
 * Renewing a term was previously only possible as a side effect of selling the
 * organization a block of credits, because that is the only place the term was
 * ever written. That conflated two things which are not the same: an
 * organization whose term simply needs extending should not have to be sold
 * credits it did not ask for, and an administrator correcting a term typed
 * wrongly had no way to do it at all.
 *
 * The pool's frozen flag is a pure function of the term — OrganizationTermScheduler
 * freezes exactly those organizations whose term has passed — so this endpoint
 * settles it immediately rather than leaving the dialog reporting a paused pool
 * until the next sweep happens to run. Unfreezing is what makes this a renewal:
 * credits carried over from a lapsed term become spendable again, which is what
 * carrying them over was for.
 *
 * Body: { organizationId, termEndsAt }
 *
 * `termEndsAt` is an ISO-8601 string. An empty string clears the term back to
 * the epoch sentinel, which reads as "Not set" everywhere and is deliberately
 * NOT treated as a term that ended in 1970 — the scheduler skips it, so an
 * organization without an agreed term is left alone rather than frozen.
 */
async function setOrganizationTerm(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const termEndsAtValue = typeof body?.termEndsAt === "string" ? body.termEndsAt.trim() : "";

    if (organizationId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    // The epoch sentinel is the "no term agreed" value the rest of the system
    // already understands, so clearing writes that rather than deleting the
    // field and leaving readers to guess.
    const termEndsAt = termEndsAtValue.length > 0 ? new Date(termEndsAtValue) : new Date(0);
    if (isNaN(termEndsAt.getTime()))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST, field: "termEndsAt" });
        return;
    }

    const updateResult = await OrganizationQueryEngine.setTermEndsAt(organizationId, termEndsAt);
    if (!updateResult.updated)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    // A renewed term has to warn again as it approaches. Without this the
    // thresholds the previous term already announced stay recorded and the new
    // term lapses in silence.
    await OrganizationQueryEngine.clearAnnouncedTermThresholds(organizationId);

    // The same test OrganizationTermScheduler applies, so this endpoint and the
    // sweep can never disagree about whether a pool should be spendable.
    const bTermHasLapsed = termEndsAt.getTime() > 0 && termEndsAt.getTime() <= Date.now();
    await OrganizationCreditLedger.setFrozen(organizationId, bTermHasLapsed);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        termEndsAt: termEndsAt.toISOString(),
        frozen: bTermHasLapsed
    });
}

module.exports = { setOrganizationTerm };
