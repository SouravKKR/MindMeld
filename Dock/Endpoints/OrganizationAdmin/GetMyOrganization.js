const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Get?organizationId=...
 *
 * The organization as its owner, a delegate or a super-admin sees it: the
 * record itself, its marketplace deck perks (read-only to everyone here — those
 * are commercial terms only a super-admin sets) and its members.
 *
 * The caller's own standing rides along so the page can render only the
 * sections they may use. Standing is resolved from stored state, never from
 * anything the client sent.
 */
async function getMyOrganization(request, response)
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

    const perks = await OrganizationDeckPerkQueryEngine.listPerksForOrganization(organizationId);
    const members = await OrganizationMemberQueryEngine.listMembers(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organization: authority.organization.toJson(),
        perks: perks.map(perk => perk.toJson()),
        members: members.map(member => member.toJson()),
        authority:
        {
            isSuperAdmin: authority.isSuperAdmin,
            isOwner: authority.isOwner,
            delegatePowers: authority.delegatePowers
        }
    });
}

module.exports = { getMyOrganization };
