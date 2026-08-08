const OrganizationQueryEngine = require("../../Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationPermissionRuleQueryEngine = require("../../Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const OrganizationFeatureSelection = require("../../Globals/Classes/Organization/OrganizationFeatureSelection");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Organizations/SetLimits  (super-admin)
 *
 * The platform's side of an organization's agreement: how much storage it may
 * grant each member, how many credits any one member may receive in a month,
 * how many decks it may publish, and which AI features its permission rules are
 * allowed to reach.
 *
 * Everything the organization configures for itself is clamped to these, so
 * lowering one takes effect at once — a stored rule granting more than the new
 * ceiling stops granting the excess on the next read. The rules are ALSO
 * re-clamped here, so what is stored never claims more than the agreement
 * allows even while nobody is reading it; without that, an administrator
 * inspecting the rules after a downgrade would see grants that no longer
 * happen and reasonably conclude the ceiling had not applied.
 *
 * The owner's own features (`adminAllowedFeatures`) are set here as well. They
 * are a direct platform grant rather than a ceiling, so nothing is clamped to
 * them and they are NOT clamped to `grantableFeatures` — that list bounds what
 * the organization may hand its MEMBERS, and bounding the owner's own
 * capability by it would let an owner strip themselves by editing their
 * allow-list.
 *
 * Body: { organizationId, maxStorageGrantBytesPerMember?, maxCreditsPerMemberPerMonth?,
 *         maxPublishedDecks?, grantableFeatures?, adminAllowedFeatures? }
 *
 * Every field is optional and an absent one is left alone, so a single ceiling
 * can be adjusted without restating the others and clearing them by omission.
 */
async function setOrganizationEntitlementLimits(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    if (organizationId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_ORGANIZATION_ID });
        return;
    }

    const organization = await OrganizationQueryEngine.getOrganizationById(organizationId);
    if (!organization)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.ORG_NOT_FOUND });
        return;
    }

    const limits = {};

    if (body.maxStorageGrantBytesPerMember !== undefined)
    {
        const storageBytes = Number(body.maxStorageGrantBytesPerMember);
        if (!Number.isInteger(storageBytes) || storageBytes < 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST, field: "maxStorageGrantBytesPerMember" });
            return;
        }
        limits.maxStorageGrantBytesPerMember = storageBytes;
    }

    if (body.maxCreditsPerMemberPerMonth !== undefined)
    {
        const monthlyCap = Number(body.maxCreditsPerMemberPerMonth);
        if (!Number.isFinite(monthlyCap) || monthlyCap < 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST, field: "maxCreditsPerMemberPerMonth" });
            return;
        }
        // Zero means no cap, which is the model's own default — kept rather than
        // rejected so an agreement without a per-member limit can be expressed.
        limits.maxCreditsPerMemberPerMonth = monthlyCap;
    }

    if (body.maxPublishedDecks !== undefined)
    {
        const publishedDeckCap = Number(body.maxPublishedDecks);
        if (!Number.isInteger(publishedDeckCap) || publishedDeckCap < 0)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_REQUEST, field: "maxPublishedDecks" });
            return;
        }
        limits.maxPublishedDecks = publishedDeckCap;
    }

    if (body.grantableFeatures !== undefined)
    {
        const grantableValidation = OrganizationFeatureSelection.validate(body.grantableFeatures);
        if (!grantableValidation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_FEATURE_SELECTION, field: "grantableFeatures", featureValue: grantableValidation.invalidValue });
            return;
        }

        limits.grantableFeatures = grantableValidation.featureValues;
    }

    if (body.adminAllowedFeatures !== undefined)
    {
        const adminValidation = OrganizationFeatureSelection.validate(body.adminAllowedFeatures);
        if (!adminValidation.valid)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.INVALID_FEATURE_SELECTION, field: "adminAllowedFeatures", featureValue: adminValidation.invalidValue });
            return;
        }

        limits.adminAllowedFeatures = adminValidation.featureValues;
    }

    const updateResult = await OrganizationQueryEngine.setEntitlementLimits(organizationId, limits);
    if (!updateResult.updated)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    // Re-clamp what the organization already configured against the ceilings as
    // they now stand. replaceRules applies the clamp itself, so feeding it the
    // stored rules is enough — and it is idempotent, so a ceiling that did not
    // move leaves every rule byte-identical.
    let rulesReclamped = 0;
    try
    {
        const updatedOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        const storedRules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organizationId);

        if (storedRules.length > 0)
        {
            const replaceResult = await OrganizationPermissionRuleQueryEngine.replaceRules
            (
                organizationId,
                storedRules.map(rule => rule.toJson()),
                updatedOrganization.getGrantableFeatures() || [],
                updatedOrganization.getMaxStorageGrantBytesPerMember()
            );
            rulesReclamped = replaceResult.replaced;
        }
    }
    catch (reclampError)
    {
        // The ceilings are already stored and are enforced on every read, so a
        // failure here costs tidiness rather than correctness. Reported instead
        // of failing the request, which would invite a retry that changes
        // nothing.
        console.warn(`[SetOrganizationEntitlementLimits] Rule re-clamp failed for ${organizationId}: ${reclampError?.message || reclampError}`);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, organizationId: organizationId, applied: updateResult.applied, rulesReclamped: rulesReclamped });
}

module.exports = { setOrganizationEntitlementLimits };
