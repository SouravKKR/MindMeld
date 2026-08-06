const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function bulkRemoveOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds : [];

    if (memberIds.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_MEMBER_IDS });
        return;
    }

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const removeResult = await OrganizationMemberQueryEngine.bulkRemoveMembers(organizationId, memberIds);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        summary:
        {
            requested: memberIds.length,
            removed: removeResult.removed,
            notFound: removeResult.notFound
        }
    });
}

module.exports = { bulkRemoveOrganizationMembers };
