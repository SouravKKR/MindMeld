const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");


async function listMyOrganizations(request, response)
{
    const user = request.user;
    if (!user)
    {
        // The plugin should have rejected before reaching here, but
        // defend in depth.
        response.sendStatusCode(401);
        return;
    }

    let organizations;
    if (user.getRole() === userRoles.ADMIN)
    {
        organizations = await OrganizationQueryEngine.listOrganizations();
    }
    else
    {
        organizations = await OrganizationQueryEngine.listActiveOrganizationsByAdminUserId(user.getId());
    }

    response.statusCode = 200;
    response.sendJson({ success: true, organizations: organizations.map(organization => organization.toJson()) });
}

module.exports = { listMyOrganizations };
