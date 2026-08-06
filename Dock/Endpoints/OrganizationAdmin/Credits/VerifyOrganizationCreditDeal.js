const OrganizationAuthorityResolver = require("../../../Globals/Classes/Organization/OrganizationAuthorityResolver");
const OrganizationCreditDealCompletionService = require("../../../Globals/Classes/Organization/OrganizationCreditDealCompletionService");
const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const PaymentProviderFactory = require("../../../Globals/Classes/Payments/PaymentProviderFactory");
const { organizationDelegatePowers } = require("../../../Globals/Enumerations/OrganizationDelegatePowers");
const { creditDealTargetTypes } = require("../../../Globals/Enumerations/CreditDealTargetTypes");
const {httpStatus} = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");


/**
 * POST /Organization/Credits/Deals/Verify
 *
 * Body: { organizationId, providerOrderId, providerPaymentId, signature }
 *
 * The organization admin's browser leg after paying for a block of credits. It
 * confirms the provider signature and hands settlement to the shared completion
 * service — the same code the provider webhook runs, so an admin who closes the
 * tab mid-verify still gets their credits.
 *
 * Nothing about WHAT is credited comes from this request. The credit count, the
 * price and the term all come from the stored deal, so the body can only ever
 * identify a payment, never describe one.
 */
async function verifyOrganizationCreditDeal(request, response)
{
    const body = await request.getBody();
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    const providerOrderId = typeof body?.providerOrderId === "string" ? body.providerOrderId : "";
    const providerPaymentId = typeof body?.providerPaymentId === "string" ? body.providerPaymentId : "";
    const signature = typeof body?.signature === "string" ? body.signature : "";

    const authority = await OrganizationAuthorityResolver.requirePower(request.user, organizationId, organizationDelegatePowers.DISTRIBUTE_CREDITS);
    if (!authority.allowed)
    {
        response.statusCode = OrganizationAuthorityResolver.statusForDenial(authority);
        response.sendJson({ success: false, error: authority.reason });
        return;
    }

    if (!providerOrderId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const deal = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!deal || deal.getTargetType() !== creditDealTargetTypes.ORGANIZATION_CREDIT_POOL)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ success: false, error: ErrorCodes.DEAL_NOT_FOUND });
        return;
    }

    // The deal must belong to the organization the caller has standing in —
    // otherwise an admin of one organization could settle another's deal into
    // their own pool by quoting its order id.
    if (deal.getTargetId() !== organizationId)
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ success: false, error: ErrorCodes.NOT_ORG_ADMIN });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(deal.getPaymentProvider());
    const verification = await provider.verifyPayment({ providerOrderId, providerPaymentId, signature });
    if (!verification.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ success: false, error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: verification.reason });
        return;
    }

    const completion = await OrganizationCreditDealCompletionService.complete
    (
        providerOrderId,
        providerPaymentId,
        OrganizationCreditDealCompletionService.SOURCE_VERIFY
    );

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        creditsAdded: completion.creditsAdded,
        alreadyProcessed: completion.alreadyProcessed
    });
}

module.exports = { verifyOrganizationCreditDeal };
