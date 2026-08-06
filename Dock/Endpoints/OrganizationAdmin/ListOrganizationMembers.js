const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Members/List?organizationId=...
 *
 * Readable by anyone with standing in the organization — owner, delegate or
 * super-admin. Changing the roster needs the MANAGE_MEMBERS power; merely
 * seeing who is in it does not, because every delegate surface (credits,
 * permissions) is expressed in terms of these people.
 */
async function listOrganizationMembers(request, response)
{
    const queryParams = await request.getQueryParams();
    const organizationId = typeof queryParams?.organizationId === "string" ? queryParams.organizationId : "";

    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const members = await OrganizationMemberQueryEngine.listMembers(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: organizationId,
        currentMemberCount: authority.organization.getCurrentMemberCount(),
        maxMembers: authority.organization.getMaxMembers(),
        members: members.map(member => member.toJson())
    });
}

module.exports = { listOrganizationMembers };
