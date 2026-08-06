const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const OrganizationAuthorityResolver = require("../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationMemberProfileNormaliser = require("../../Globals/Classes/Organization/OrganizationMemberProfileNormaliser");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const { organizationDelegatePowers } = require("../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

// The importer accepts a whole roster in one call, so the ceiling is generous
// — but not unbounded, or one paste could reserve every seat and time the
// request out mid-write.
const MAXIMUM_IMPORT_ROWS = 5000;


/**
 * POST /Organization/Members/Import
 *
 * Body: { organizationId, members: [{ email, attributes?, tags? }] }
 *
 * The one way a roster spreadsheet becomes members. Adds everyone who is new,
 * and REPLACES the tags and attributes of everyone who already exists — the
 * sheet is the source of truth, so a tag deleted from the sheet is deleted from
 * the member. Merging instead would mean a tag applied by mistake could never
 * be corrected by re-importing a fixed sheet.
 *
 * Members who are absent from the sheet are left completely alone. Removing
 * people is a separate, explicit action with its own confirmation, because
 * "this upload happened to omit a column of emails" must never be the same
 * gesture as "remove these people".
 */
async function importOrganizationMembers(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const submittedMembers = Array.isArray(body?.members) ? body.members : [];

    if (submittedMembers.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_EMAILS });
        return;
    }

    if (submittedMembers.length > MAXIMUM_IMPORT_ROWS)
    {
        response.statusCode = httpStatus.PAYLOAD_TOO_LARGE;
        response.sendJson({ success: false, error: ErrorCodes.BATCH_LIMIT_EXCEEDED, maximumRows: MAXIMUM_IMPORT_ROWS });
        return;
    }

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.MANAGE_MEMBERS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    if (authority.organization.getStatus() !== organizationStatus.ACTIVE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ success: false, error: ErrorCodes.ORG_NOT_ACTIVE });
        return;
    }

    // Validate, normalise and de-duplicate within the submitted batch. A sheet
    // listing the same person twice is normal (a re-export, a merged file), so
    // the LAST row wins rather than the import failing.
    const profileByEmail = new Map();
    const invalidEmails = [];

    for (const submittedMember of submittedMembers)
    {
        const rawEmail = typeof submittedMember?.email === "string" ? submittedMember.email.trim().toLowerCase() : "";
        if (rawEmail.length === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))
        {
            invalidEmails.push(typeof submittedMember?.email === "string" ? submittedMember.email : "");
            continue;
        }

        const normalisedProfile = OrganizationMemberProfileNormaliser.normalise(submittedMember);
        profileByEmail.set(rawEmail, { email: rawEmail, ...normalisedProfile });
    }

    if (profileByEmail.size === 0)
    {
        response.statusCode = httpStatus.OK;
        response.sendJson
        ({
            success: true,
            summary: { requested: submittedMembers.length, added: 0, updated: 0, invalidEmail: invalidEmails.length, autoAssignedDecks: 0 }
        });
        return;
    }

    const allEmails = Array.from(profileByEmail.keys());
    const existingEmails = await OrganizationMemberQueryEngine.listExistingEmails(organizationId, allEmails);

    const newProfiles = allEmails.filter(email => !existingEmails.has(email)).map(email => profileByEmail.get(email));
    const existingProfiles = allEmails.filter(email => existingEmails.has(email)).map(email => profileByEmail.get(email));

    // Existing members first: this only rewrites their tags and attributes, so
    // it cannot fail on capacity and leaves nothing half-done if the seat
    // reservation below is refused.
    const updateResult = await OrganizationMemberQueryEngine.replaceProfilesForExistingMembers(organizationId, existingProfiles);

    let addedCount = 0;
    let autoAssignedDecks = 0;
    let bCapacityRefused = false;

    if (newProfiles.length > 0)
    {
        const capacityResult = await OrganizationQueryEngine.tryIncrementMemberCountBy(organizationId, newProfiles.length);
        if (!capacityResult.ok)
        {
            bCapacityRefused = true;
        }
        else
        {
            let bulkAddResult = null;
            try
            {
                bulkAddResult = await OrganizationMemberQueryEngine.bulkAddMembers(organizationId, newProfiles, request.user.getId());
            }
            catch (bulkAddError)
            {
                await OrganizationQueryEngine.decrementMemberCountBy(organizationId, newProfiles.length);
                console.error(`[ImportOrganizationMembers] bulkAddMembers threw for org=${organizationId}: ${bulkAddError.message}`);
                response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
                response.sendJson({ success: false, error: ErrorCodes.BULK_ADD_FAILED });
                return;
            }

            addedCount = bulkAddResult.added.length;

            for (const added of bulkAddResult.added)
            {
                const autoAssignResult = await OrganizationAutoAssigner.applyFreePerksForMember(organizationId, added.email);
                autoAssignedDecks = autoAssignedDecks + autoAssignResult.granted;
            }
        }
    }

    response.statusCode = bCapacityRefused ? httpStatus.CONFLICT : httpStatus.OK;
    response.sendJson
    ({
        success: !bCapacityRefused,
        error: bCapacityRefused ? ErrorCodes.CAP_REACHED : undefined,
        summary:
        {
            requested: submittedMembers.length,
            added: addedCount,
            updated: updateResult.updated,
            alreadyMember: existingProfiles.length,
            invalidEmail: invalidEmails.length,
            autoAssignedDecks: autoAssignedDecks,
            // Reported separately so the dialog can say "12 people need seats
            // you do not have" rather than silently importing only the updates.
            refusedForCapacity: bCapacityRefused ? newProfiles.length : 0
        },
        invalidEmails: invalidEmails.slice(0, 20)
    });
}

module.exports = { importOrganizationMembers };
