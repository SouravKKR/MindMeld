const Organization = require("../../Globals/Model/Organization");
const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationDeckPerkQueryEngine = require("../../Globals/Classes/Organization/OrganizationDeckPerkQueryEngine");
const OrgAdminVerificationManager = require("../../Globals/Classes/Authentication/OrgAdminVerificationManager");
const OrganizationFeatureSelection = require("../../Globals/Classes/Organization/OrganizationFeatureSelection");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const { organizationStatus } = require("../../Globals/Enumerations/OrganizationStatus");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");


/**
 * POST /Admin/Organizations/Create  (super-admin)
 *
 * Creating an organization is FREE. Money only ever changes hands for the
 * credits an organization buys, which is a separate negotiated credit deal — so
 * there is no order, no payment row and no PENDING_PAYMENT state here. Every
 * organization is ACTIVE the moment it is created.
 *
 * That matters beyond simplicity. While creation was billed, an organization
 * sat at PENDING_PAYMENT until a provider callback cleared it, and every edit
 * endpoint that gates on ACTIVE refused with ORG_NOT_ACTIVE. Wherever the
 * callback never arrived the organization was permanently uneditable and
 * invisible to its own admin.
 *
 * The owner's own capability inside the organization's view is set here too.
 * It defaults to EVERY feature: the owner is the person the institute is run
 * by, and an organization whose administrator cannot use the product they are
 * administering is not a state anybody asks for. Inside an organization view
 * the personal plan is not consulted at all, so without this grant an owner who
 * never added themselves to their own roster would run the whole institute on
 * the Free floor — including one who pays for Pro Plus personally.
 *
 * Body: { name, adminEmail, verificationToken, currency?, maxMembers, deckPerks?,
 *         adminAllowedFeatures? }
 */
async function createOrganization(request, response)
{
    const body = await request.getBody();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const adminEmail = typeof body?.adminEmail === "string" ? body.adminEmail.trim().toLowerCase() : "";
    const verificationToken = typeof body?.verificationToken === "string" ? body.verificationToken : "";
    const currency = typeof body?.currency === "string" && body.currency.length > 0 ? body.currency.toUpperCase() : "INR";
    const maxMembers = Number.isInteger(body?.maxMembers) ? body.maxMembers : 0;
    const deckPerks = Array.isArray(body?.deckPerks) ? body.deckPerks : [];

    // Absent means "all of them" rather than "none": the dialog ticks every box
    // by default, and a caller that never mentions the field is asking for that
    // same default. An explicitly empty array is still honoured — that is how a
    // super-admin says the owner gets the Free floor only.
    let adminAllowedFeatures = OrganizationFeatureSelection.getAllFeatureValues();
    if (body?.adminAllowedFeatures !== undefined)
    {
        const featureValidation = OrganizationFeatureSelection.validate(body.adminAllowedFeatures);
        if (!featureValidation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_FEATURE_SELECTION, field: "adminAllowedFeatures", featureValue: featureValidation.invalidValue });
            return;
        }
        adminAllowedFeatures = featureValidation.featureValues;
    }

    if (name.length === 0 || name.length > 256)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_NAME });
        return;
    }
    if (!adminEmail || adminEmail.indexOf("@") < 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_ADMIN_EMAIL });
        return;
    }
    if (maxMembers <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_MAX_MEMBERS });
        return;
    }

    const tokenValid = await OrgAdminVerificationManager.isTokenValid(adminEmail, verificationToken);
    if (!tokenValid)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_VERIFICATION_TOKEN });
        return;
    }

    // Validate every perk shape up front so a malformed entry can never leave a
    // half-written perk set behind.
    for (const perkInput of deckPerks)
    {
        const validation = OrganizationDeckPerkQueryEngine.validatePerk(perkInput);
        if (!validation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ success: false, error: ErrorCodes.INVALID_PERK, reason: validation.reason, deckId: perkInput?.deckId });
            return;
        }
    }

    const now = new Date();

    // Bind the owner's user id immediately when their account already exists.
    // UserRoleReconciliator also back-fills this at login, but waiting for that
    // left a freshly created organization invisible to its own owner — every
    // OrganizationAdmin handler resolves ownership through adminUserId.
    const existingAdminUser = await AuthenticationQueryEngine.getUserByEmail(adminEmail);
    const adminUserId = existingAdminUser ? existingAdminUser.getId() : "";

    const organization = new Organization
    ({
        name: name.slice(0, 256),
        adminEmail: adminEmail,
        adminUserId: adminUserId,
        status: organizationStatus.ACTIVE,
        currency: currency,
        creationAmountMinor: 0,
        maxMembers: maxMembers,
        currentMemberCount: 0,
        creationDate: now,
        activationDate: now,
        adminAllowedFeatures: adminAllowedFeatures,
        additionalData: {}
    });

    const created = await OrganizationQueryEngine.createOrganization(organization);

    if (deckPerks.length > 0)
    {
        await OrganizationDeckPerkQueryEngine.replacePerks(created.getId(), deckPerks);
    }

    // Nothing downstream consumes the token now that there is no payment step.
    await OrgAdminVerificationManager.consumeToken(adminEmail, verificationToken);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        organizationId: created.getId(),
        status: organizationStatus.ACTIVE,
        requiresPayment: false,
        // Echoed so the caller can show what the owner actually ended up with
        // rather than what it hoped it had sent.
        adminAllowedFeatures: adminAllowedFeatures
    });
}

module.exports = { createOrganization };
