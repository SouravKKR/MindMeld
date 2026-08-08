const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationPermissionRuleQueryEngine = require("../../Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const MemberAudienceMatcher = require("../../Globals/Classes/Organization/MemberAudienceMatcher");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// The whole matched set, not a sample: an administrator about to grant a paid
// feature to a cohort asked who is in it, and ten example addresses do not
// answer that. An organization is seat-capped well below this, so the ceiling
// bounds a crafted request without standing between an institute and its own
// roster — and when it does bite, the response says so.
const MAXIMUM_PREVIEW_MEMBERS = 5000;


/**
 * POST /Organization/Permissions/PreviewRule
 *
 * Body: { organizationId, tagFilter?, matchMode?, attributeConditions? }
 *
 * Who one rule currently covers — the count, and every matching member.
 *
 * This exists because a rule stopped being readable at a glance the moment it
 * could say "admitted between 2022 and 2024, role teacher, tagged scholarship".
 * Nobody can tell by eye whether that is four people or four hundred, and the
 * mistake it hides is granting a paid feature to an entire roster. The preview
 * is the only thing standing between writing that rule and saving it.
 *
 * The query is built by the SAME matcher that decides the rule at request time,
 * so what this screen promises and what a member actually gets are the same
 * sentence evaluated twice, not two implementations that agree for now.
 */
async function previewOrganizationPermissionRule(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    // Readable by anyone with standing: seeing who a rule covers is reading, and
    // the roster it reports on is already visible to the same people.
    const authority = await OrganizationAuthorityResolver.resolve(request.user, organizationId);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const conditionValidation = OrganizationPermissionRuleQueryEngine.validateAttributeConditions(body?.attributeConditions);
    if (!conditionValidation.valid)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: conditionValidation.reason });
        return;
    }

    const audience =
    {
        tagFilter: body?.tagFilter,
        matchMode: body?.matchMode,
        attributeConditions: body?.attributeConditions
    };

    const audienceQuery = MemberAudienceMatcher.buildAudienceQuery(audience);
    const previewResult = await OrganizationMemberQueryEngine.listMembersMatching(organizationId, audienceQuery, MAXIMUM_PREVIEW_MEMBERS);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        matchedCount: previewResult.matchedCount,
        // Everyone the rule reaches, in a shape the screen can list and the
        // administrator can download and check against their own records.
        members: previewResult.members.map(member => (
        {
            email: member.getEmail(),
            tags: member.getTags(),
            attributes: member.getAttributes()
        })),
        truncated: previewResult.truncated,
        // Stated so an administrator reading "covers everyone" knows whether
        // that is the rule being broad or the rule being empty.
        matchesEveryone: MemberAudienceMatcher.isEveryone(audience)
    });
}

module.exports = { previewOrganizationPermissionRule };
