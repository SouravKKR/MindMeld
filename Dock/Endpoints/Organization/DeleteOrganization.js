const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const UserRoleReconciliator = require("../../Globals/Classes/Authentication/UserRoleReconciliator");
const PeriodicAssignmentQueryEngine = require("../../Globals/Classes/Credits/PeriodicAssignmentQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


async function deleteOrganization(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    const deleteResult = await OrganizationQueryEngine.deleteOrganization(organizationId);
    if (!deleteResult.deleted)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    // Proactively demote the admin's role to USER if they no longer
    // admin any active org. Already-issued licenses are NOT touched —
    // members keep deck access until their license's own expiresAt.
    if (deleteResult.adminUserId && deleteResult.adminUserId.length > 0)
    {
        await UserRoleReconciliator.revokeOrgAdminIfNoActiveOrgs(deleteResult.adminUserId);
    }

    // Stop any recurring credit cycles scoped to this org so they don't linger
    // ACTIVE in the admin list pointing at a deleted org. (The lazy reconciler
    // would already grant nothing — no members resolve — but terminating keeps
    // the management view honest.)
    await PeriodicAssignmentQueryEngine.terminateForOrganization(organizationId, new Date());

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId });
}

module.exports = { deleteOrganization };
