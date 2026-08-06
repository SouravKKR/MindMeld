const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditDistributionService = require("../../../Globals/Classes/Organization/OrganizationCreditDistributionService");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Credits/Distribute/Preview
 *
 * Body: { organizationId, tagFilter, tagMatchMode, amount, amountMode }
 *
 * Works out exactly who would receive what, and moves nothing. The response is
 * what the confirmation dialog and the downloadable before/after sheet are
 * built from, so it carries each recipient's balance before, the amount, the
 * balance after, and whether their monthly ceiling clipped it.
 *
 * It reports the pool balance on both sides too: the most common mistake with a
 * distribution is not who it reaches but how much of the pool it consumes.
 */
async function previewOrganizationCreditDistribution(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.DISTRIBUTE_CREDITS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_AMOUNT });
        return;
    }

    if (!OrganizationCreditDistributionService.isValidAmountMode(body?.amountMode))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const distributionPlan = await OrganizationCreditDistributionService.plan
    (
        authority.organization,
        {
            tagFilter: Array.isArray(body?.tagFilter) ? body.tagFilter : [],
            tagMatchMode: body?.tagMatchMode,
            amount: amount,
            amountMode: body.amountMode
        }
    );

    if (!distributionPlan.ok)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: distributionPlan.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, ...distributionPlan });
}

module.exports = { previewOrganizationCreditDistribution };
