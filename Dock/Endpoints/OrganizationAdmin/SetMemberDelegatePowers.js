const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Members/SetDelegatePowers
 *
 * Body: { organizationId, memberId, delegatePowers }
 *
 * Hands an ordinary member a subset of the owner's powers, as a bitwise
 * OrganizationDelegatePowers flag set. Sending 0 revokes everything.
 *
 * Owner (or super-admin) only — a delegate can never appoint another delegate,
 * because that would let a single MANAGE_MEMBERS grant escalate into every
 * other power. The submitted value is masked against the known flags, so an
 * unknown bit can never be stored and later interpreted as a power that did not
 * exist when it was granted.
 */
async function setMemberDelegatePowers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberId = typeof body?.memberId === "string" ? body.memberId : "";
    const submittedPowers = body?.delegatePowers;

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed || !(authority.isOwner || authority.isSuperAdmin))
    {
        response.statusCode = authority.allowed ? httpStatus.FORBIDDEN : OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.allowed ? ErrorCodes.NOT_ORG_ADMIN : authority.reason });
        return;
    }

    if (memberId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    if (!Number.isInteger(submittedPowers) || submittedPowers < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    // Mask to the flags this build knows about. An unrecognised bit is dropped
    // rather than refused, so a newer client cannot store a power the server
    // would not be able to enforce.
    const maskedPowers = submittedPowers & OrganizationAuthorityResolver.ALL_POWERS;

    const updateResult = await OrganizationMemberQueryEngine.setDelegatePowers(organizationId, memberId, maskedPowers);
    if (!updateResult.updated)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.MEMBER_NOT_FOUND });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        memberId: memberId,
        delegatePowers: maskedPowers,
        // The role floor a delegate needs is applied at their next login by
        // UserRoleReconciliator; nothing here can promote a live session.
        appliesOnNextLogin: maskedPowers !== organizationDelegatePowers.NONE
    });
}

module.exports = { setMemberDelegatePowers };
