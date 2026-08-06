const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditDistributionService = require("../../../Globals/Classes/Organization/OrganizationCreditDistributionService");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

// The client mints this per staged distribution. It is what makes a retried
// request — a double click, a flaky connection — credit each member once.
const MINIMUM_GRANT_KEY_LENGTH = 8;
const MAXIMUM_GRANT_KEY_LENGTH = 128;


/**
 * POST /Organization/Credits/Distribute/Apply
 *
 * Body: { organizationId, tagFilter, tagMatchMode, amount, amountMode, grantKey }
 *
 * Hands out the credits. The recipient set is re-resolved server-side rather
 * than taken from whatever the preview returned, because the roster can change
 * between previewing and confirming and the client's copy is not evidence.
 *
 * The pool is debited once, atomically, for the whole total before anybody is
 * credited — so a distribution can never credit half a roster and then stop for
 * want of funds.
 */
async function applyOrganizationCreditDistribution(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const grantKey = typeof body?.grantKey === "string" ? body.grantKey : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.DISTRIBUTE_CREDITS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    if (grantKey.length < MINIMUM_GRANT_KEY_LENGTH || grantKey.length > MAXIMUM_GRANT_KEY_LENGTH)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.INVALID_REQUEST });
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

    const applyResult = await OrganizationCreditDistributionService.apply
    (
        authority.organization,
        {
            tagFilter: Array.isArray(body?.tagFilter) ? body.tagFilter : [],
            tagMatchMode: body?.tagMatchMode,
            amount: amount,
            amountMode: body.amountMode
        },
        grantKey,
        request.user.getId()
    );

    if (!applyResult.ok)
    {
        // A refusal for funds or a frozen pool is a conflict, not a bad
        // request: the request was well-formed and the state refused it.
        const bIsStateRefusal = applyResult.reason === ErrorCodes.ORG_POOL_INSUFFICIENT
            || applyResult.reason === ErrorCodes.ORG_POOL_FROZEN
            || applyResult.reason === ErrorCodes.MONTHLY_CAP_EXCEEDED
            || applyResult.reason === ErrorCodes.NO_RECIPIENTS;

        response.statusCode = bIsStateRefusal ? httpStatus.CONFLICT : httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: applyResult.reason, plan: applyResult.plan });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, ...applyResult });
}

module.exports = { applyOrganizationCreditDistribution };
