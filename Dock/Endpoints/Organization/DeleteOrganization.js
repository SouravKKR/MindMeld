const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const UserRoleReconciliator = require("../../Globals/Classes/Authentication/UserRoleReconciliator");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function deleteOrganization(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }

    const deleteResult = await OrganizationQueryEngine.deleteOrganization(organizationId);
    if (!deleteResult.deleted)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }

    // Proactively demote the admin's role to USER if they no longer
    // admin any active org. Already-issued licenses are NOT touched —
    // members keep deck access until their license's own expiresAt.
    if (deleteResult.adminUserId && deleteResult.adminUserId.length > 0)
    {
        await UserRoleReconciliator.revokeOrgAdminIfNoActiveOrgs(deleteResult.adminUserId);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId });
}

module.exports = { deleteOrganization };
