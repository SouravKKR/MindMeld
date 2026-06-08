const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");


async function listOrganizationMembers(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    if (!organizationId)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = 404;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }

    const user = request.user;
    if (user.getRole() !== userRoles.ADMIN && organization.getAdminUserId() !== user.getId())
    {
        response.statusCode = 403;
        response.sendJson({ success: false, error: "NOT_ORG_ADMIN" });
        return;
    }

    const members = await OrganizationMemberQueryEngine.listMembers(organizationId);

    response.statusCode = 200;
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
