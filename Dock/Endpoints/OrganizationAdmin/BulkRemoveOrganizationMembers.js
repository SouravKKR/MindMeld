const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");


async function bulkRemoveOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds : [];

    if (!organizationId)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (memberIds.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_MEMBER_IDS" });
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

    const removeResult = await OrganizationMemberQueryEngine.bulkRemoveMembers(organizationId, memberIds);

    response.statusCode = 200;
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
