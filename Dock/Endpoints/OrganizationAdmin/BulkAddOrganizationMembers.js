const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


async function bulkAddOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const submittedEmails = Array.isArray(body?.emails) ? body.emails : [];

    if (!organizationId)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_ORGANIZATION_ID" });
        return;
    }
    if (submittedEmails.length === 0)
    {
        response.statusCode = 400;
        response.sendJson({ success: false, error: "MISSING_EMAILS" });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = 404;
        response.sendJson({ success: false, error: "ORG_NOT_FOUND" });
        return;
    }

    const user = request.user;
    if (user.getRole() !== userRoles.ADMIN && organization.getAdminUserId() !== user.getId())
    {
        response.statusCode = 403;
        response.sendJson({ success: false, error: "NOT_ORG_ADMIN" });
        return;
    }
    if (organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = 409;
        response.sendJson({ success: false, error: "ORG_NOT_ACTIVE" });
        return;
    }

    const requestedCount = submittedEmails.length;
    const perEmail = [];
    const validatedEmailSet = new Set();
    const validatedEmails = [];

    // Validate + normalise + de-dupe within the submitted batch.
    for (const rawEmail of submittedEmails)
    {
        if (typeof rawEmail !== "string")
        {
            perEmail.push({ email: String(rawEmail), status: "invalid_email" });
            continue;
        }
        const trimmedEmail = rawEmail.trim().toLowerCase();
        if (!EMAIL_REGEX.test(trimmedEmail))
        {
            perEmail.push({ email: rawEmail, status: "invalid_email" });
            continue;
        }
        if (validatedEmailSet.has(trimmedEmail))
        {
            // In-batch duplicate — collapse silently; only the first
            // occurrence proceeds.
            continue;
        }
        validatedEmailSet.add(trimmedEmail);
        validatedEmails.push(trimmedEmail);
    }

    // De-dupe against the existing membership in this org.
    const existingEmails = await OrganizationMemberQueryEngine.listExistingEmails(organizationId, validatedEmails);
    const additionsList = [];
    for (const email of validatedEmails)
    {
        if (existingEmails.has(email))
        {
            perEmail.push({ email: email, status: "already_member" });
        }
        else
        {
            additionsList.push(email);
        }
    }

    if (additionsList.length === 0)
    {
        response.statusCode = 200;
        response.sendJson
        ({
            success: true,
            summary:
            {
                requested: requestedCount,
                added: 0,
                alreadyMember: perEmail.filter(entry => entry.status === "already_member").length,
                invalidEmail: perEmail.filter(entry => entry.status === "invalid_email").length,
                autoAssignedDecks: 0
            },
            perEmail: perEmail
        });
        return;
    }

    // Atomic cap reservation for the additions. Either the org has
    // space for all of them or none get inserted — no partial accept.
    const capResult = await OrganizationQueryEngine.tryIncrementMemberCountBy(organizationId, additionsList.length);
    if (!capResult.ok)
    {
        response.statusCode = 409;
        response.sendJson({ success: false, error: "CAP_REACHED" });
        return;
    }

    let bulkAddResult;
    try
    {
        bulkAddResult = await OrganizationMemberQueryEngine.bulkAddMembers(organizationId, additionsList, user.getId());
    }
    catch (bulkError)
    {
        // Non-E11000 errors propagate out of bulkAddMembers. The
        // E11000 case is handled gracefully inside the query engine.
        // Roll the cap reservation back so currentMemberCount never
        // outpaces the actual row count.
        await OrganizationQueryEngine.decrementMemberCountBy(organizationId, additionsList.length);
        console.error(`[BulkAddOrganizationMembers] bulkAddMembers threw for org=${organizationId}: ${bulkError.message}`);
        response.statusCode = 500;
        response.sendJson({ success: false, error: "BULK_ADD_FAILED" });
        return;
    }

    for (const added of bulkAddResult.added)
    {
        perEmail.push({ email: added.email, status: "added" });
    }
    for (const alreadyMemberEmail of bulkAddResult.alreadyMember)
    {
        perEmail.push({ email: alreadyMemberEmail, status: "already_member" });
    }
    for (const invalidEmail of bulkAddResult.invalidEmail)
    {
        perEmail.push({ email: invalidEmail, status: "invalid_email" });
    }

    // Auto-assign FREE perks for every successfully-added email. Each
    // call is idempotent and only mints rows for emails that map to a
    // real user account.
    let totalAutoAssigned = 0;
    for (const added of bulkAddResult.added)
    {
        const autoAssignResult = await OrganizationAutoAssigner.applyFreePerksForMember(organizationId, added.email);
        totalAutoAssigned += autoAssignResult.granted;
    }

    response.statusCode = 200;
    response.sendJson
    ({
        success: true,
        summary:
        {
            requested: requestedCount,
            added: bulkAddResult.added.length,
            alreadyMember: perEmail.filter(entry => entry.status === "already_member").length,
            invalidEmail: perEmail.filter(entry => entry.status === "invalid_email").length,
            autoAssignedDecks: totalAutoAssigned
        },
        perEmail: perEmail
    });
}

module.exports = { bulkAddOrganizationMembers };
