const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationPermissionRuleQueryEngine = require("../../Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Permissions/Set
 *
 * Body: { organizationId, rules: [{ name, tagFilter, matchMode, attributeConditions,
 *          allowedFeatures, storageGrantBytes }] }
 *
 * Replaces the whole rule set. Replacement rather than per-rule editing because
 * what a member ends up with depends on every rule at once — saving the set the
 * administrator was looking at is the only way the result matches what they saw.
 *
 * Every rule is clamped on write to the features this organization was sold and
 * to its per-member storage ceiling, so a crafted request cannot store a grant
 * the server would refuse to honour later. Clamping at write AND at read means
 * a rule stored before a ceiling was lowered stops granting the excess
 * immediately, without needing a migration.
 *
 * `attributeConditions` targets the institute's own columns — an admission year,
 * a role, a section. Each is checked against an allow-list of member-document
 * paths before it is stored, so a crafted rule cannot be written against
 * membership internals like delegatePowers that no screen offers and that are
 * not the institute's to target.
 */
async function setOrganizationPermissionRules(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.SET_PERMISSIONS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const submittedRules = Array.isArray(body?.rules) ? body.rules : [];

    for (const ruleInput of submittedRules)
    {
        const validation = OrganizationPermissionRuleQueryEngine.validateRule(ruleInput);
        if (!validation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: validation.reason, ruleName: ruleInput?.name });
            return;
        }
    }

    if (submittedRules.length > OrganizationPermissionRuleQueryEngine.MAXIMUM_RULES_PER_ORGANIZATION)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.BATCH_LIMIT_EXCEEDED, maximumRules: OrganizationPermissionRuleQueryEngine.MAXIMUM_RULES_PER_ORGANIZATION });
        return;
    }

    const replaceResult = await OrganizationPermissionRuleQueryEngine.replaceRules
    (
        organizationId,
        submittedRules,
        authority.organization.getGrantableFeatures() || [],
        authority.organization.getMaxStorageGrantBytesPerMember()
    );

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, replaced: replaceResult.replaced });
}

module.exports = { setOrganizationPermissionRules };
