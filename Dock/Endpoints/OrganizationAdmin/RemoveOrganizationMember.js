const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function removeOrganizationMember(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const memberId = typeof body?.memberId === "string" ? body.memberId : "";

    if (!organizationId || !memberId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_FIELDS" });
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

    const removeResult = await OrganizationMemberQueryEngine.removeMember(organizationId, memberId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        summary: { requested: 1, removed: removeResult.removed, notFound: 1 - removeResult.removed }
    });
}

module.exports = { removeOrganizationMember };
