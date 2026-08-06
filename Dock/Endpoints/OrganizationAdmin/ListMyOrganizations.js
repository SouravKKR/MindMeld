const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Mine/List
 *
 * Every organization the caller has standing in, each stamped with what they
 * may do there. A super-admin sees all of them; an owner sees the ones they
 * own; a delegate sees the ones they hold powers in. The client renders its
 * sections from these flags — and every endpoint re-checks them anyway, so the
 * flags are a convenience rather than the enforcement.
 */
async function listMyOrganizations(request, response)
{
    const user = request.user;
    if (!user)
    {
        // The plugin should have rejected before reaching here; defend in depth.
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const entries = await OrganizationAuthorityResolver.listOrganizationsForUser(user);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizations: entries.map(entry => (
        {
            ...entry.organization.toJson(),
            isOwner: entry.isOwner,
            delegatePowers: entry.delegatePowers
        }))
    });
}

module.exports = { listMyOrganizations };
