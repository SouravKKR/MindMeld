const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationPermissionRuleQueryEngine = require("../../Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const PlanMetadata = require("../../Globals/Classes/Plans/PlanMetadata");
const { planTiers } = require("../../Globals/Enumerations/PlanTiers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Organization/Permissions?organizationId=...
 *
 * The rule set, plus everything the editor needs to render it honestly: the
 * tags actually in use, the features this organization is ALLOWED to grant, and
 * the ones it can never withhold because every account has them.
 *
 * Sending the allow-list and the free floor to the client is what lets the
 * editor show a feature as unavailable-and-why instead of offering a checkbox
 * whose effect the server would silently discard.
 */
async function getOrganizationPermissionRules(request, response)
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

    const rules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organizationId);
    const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        rules: rules.map(rule => rule.toJson()),
        availableTags: vocabulary.tags,
        grantableFeatures: authority.organization.getGrantableFeatures() || [],
        // Never grantable OR withholdable: every account has these, so an
        // organization neither adds nor removes them.
        alwaysIncludedFeatures: PlanMetadata.getFeatureSet(planTiers.FREE),
        maxStorageGrantBytesPerMember: authority.organization.getMaxStorageGrantBytesPerMember()
    });
}

module.exports = { getOrganizationPermissionRules };
