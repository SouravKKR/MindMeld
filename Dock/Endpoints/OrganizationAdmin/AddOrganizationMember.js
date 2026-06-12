const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


async function addOrganizationMember(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const submittedEmail = typeof body?.email === "string" ? body.email.trim() : "";

    if (!organizationId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (!submittedEmail || submittedEmail.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: "INVALID_EMAIL" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }

    const user = request.user;
    if (user.getRole() !== userRoles.ADMIN && organization.getAdminUserId() !== user.getId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: "NOT_ORG_ADMIN" });
        return;
    }
    if (organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: "ORG_NOT_ACTIVE" });
        return;
    }

    // Cap-atomic increment first. If this lands, we own a slot — even
    // if the subsequent insert collides with E11000 (already a member),
    // we roll back the slot. Any other DB error in addMember must ALSO
    // roll back the slot to keep currentMemberCount in lock-step with
    // the row count.
    const capResult = await OrganizationQueryEngine.tryIncrementMemberCount(organizationId);
    if (!capResult.ok)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: "CAP_REACHED" });
        return;
    }

    let addResult;
    try
    {
        addResult = await OrganizationMemberQueryEngine.addMember(organizationId, submittedEmail, user.getId());
    }
    catch (addError)
    {
        await OrganizationQueryEngine.decrementMemberCountBy(organizationId, 1);
        console.error(`[AddOrganizationMember] addMember threw for org=${organizationId} email=${submittedEmail}: ${addError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ success: false, error: "ADD_MEMBER_FAILED" });
        return;
    }

    if (addResult.status === "ALREADY_MEMBER")
    {
        await OrganizationQueryEngine.decrementMemberCountBy(organizationId, 1);
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            summary: { requested: 1, added: 0, alreadyMember: 1, invalidEmail: 0, autoAssignedDecks: 0 },
            perEmail: [{ email: submittedEmail, status: "already_member" }]
        });
        return;
    }
    if (addResult.status === "INVALID_EMAIL")
    {
        await OrganizationQueryEngine.decrementMemberCountBy(organizationId, 1);
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            summary: { requested: 1, added: 0, alreadyMember: 0, invalidEmail: 1, autoAssignedDecks: 0 },
            perEmail: [{ email: submittedEmail, status: "invalid_email" }]
        });
        return;
    }

    // Successful add — fire auto-assignment for any FREE perks the org
    // has. No-op if the user doesn't exist yet; their first login picks
    // it up via applyFreePerksOnLogin. The auto-assigner is already
    // best-effort internally (catches its own errors).
    const autoAssignResult = await OrganizationAutoAssigner.applyFreePerksForMember(organizationId, submittedEmail);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        summary: { requested: 1, added: 1, alreadyMember: 0, invalidEmail: 0, autoAssignedDecks: autoAssignResult.granted },
        perEmail: [{ email: submittedEmail, status: "added" }]
    });
}

module.exports = { addOrganizationMember };
