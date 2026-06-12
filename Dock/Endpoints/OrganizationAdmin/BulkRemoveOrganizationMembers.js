const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function bulkRemoveOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberIds = Array.isArray(body?.memberIds) ? body.memberIds : [];

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (memberIds.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_MEMBER_IDS" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }

    const user = request.user;
    if (user.getRole() !== userRoles.ADMIN && organization.getAdminUserId() !== user.getId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: "NOT_ORG_ADMIN" });
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
