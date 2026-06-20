const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function listOrganizationMembers(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    if (!organizationId)
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

    const user = request.user;
    if (user.getRole() !== userRoles.ADMIN && organization.getAdminUserId() !== user.getId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.NOT_ORG_ADMIN });
        return;
    }

    const members = await OrganizationMemberQueryEngine.listMembers(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        currentMemberCount: organization.getCurrentMemberCount(),
        maxMembers: organization.getMaxMembers(),
        members: members.map(member => member.toJson())
    });
}

module.exports = { listOrganizationMembers };
