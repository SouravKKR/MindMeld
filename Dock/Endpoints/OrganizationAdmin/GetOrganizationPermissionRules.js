const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationPermissionRuleQueryEngine = require("../../Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationMemberListBuilder = require("../../Globals/Classes/Organization/OrganizationMemberListBuilder");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
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

    // The same filter metadata the roster screen renders from. Sending it here
    // is what lets a rule's conditions be built with the very controls the
    // member list uses, over the very fields it filters on — so "who this rule
    // covers" and "who this filter shows" cannot come to mean different things.
    let conditionFilters = [];
    const database = await DatabaseConnector.getDatabase();
    if (database)
    {
        const { definition } = await OrganizationMemberListBuilder.build(database, organizationId);
        conditionFilters = await Promise.all(definition.getFilters().map(filter => filter.getMetadata(database)));
    }

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        rules: rules.map(rule => rule.toJson()),
        availableTags: vocabulary.tags,
        conditionFilters: conditionFilters,
        maximumConditionsPerRule: OrganizationPermissionRuleQueryEngine.MAXIMUM_CONDITIONS_PER_RULE,
        grantableFeatures: authority.organization.getGrantableFeatures() || [],
        // Never grantable OR withholdable: every account has these, so an
        // organization neither adds nor removes them.
        alwaysIncludedFeatures: PlanMetadata.getFeatureSet(planTiers.FREE),
        // What the OWNER holds here regardless of the rules, so the screen can
        // say so. An owner is not necessarily on their own roster, so without
        // this the person with the widest access on the page would find no
        // explanation of it anywhere — and would reasonably write themselves a
        // rule they do not need. Sent to every caller who may read the rules,
        // and flagged as theirs only for the owner.
        adminAllowedFeatures: authority.organization.getAdminAllowedFeatures() || [],
        isOwner: authority.isOwner === true,
        maxStorageGrantBytesPerMember: authority.organization.getMaxStorageGrantBytesPerMember()
    });
}

module.exports = { getOrganizationPermissionRules };
