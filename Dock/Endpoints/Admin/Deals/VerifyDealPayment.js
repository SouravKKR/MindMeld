const CreditDealPaymentQueryEngine = require("../../../Globals/Classes/Credits/CreditDealPaymentQueryEngine");
const PaymentProviderFactory = require("../../../Globals/Classes/Payments/PaymentProviderFactory");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Credits/Deals/VerifyPayment
 *
 * Verifies an in-page Razorpay capture for an on-spot deal and flips its
 * status to CAPTURED. Idempotent via the atomic markCaptured CAS — the webhook
 * is the safety net if the admin closes the tab before this runs.
 *
 * Body: { providerOrderId, providerPaymentId, signature }
 */
async function verifyDealPayment(request, response)
{
    const body = await request.getBody();
    const providerOrderId = body?.providerOrderId;
    const providerPaymentId = body?.providerPaymentId;
    const signature = body?.signature;

    if (typeof providerOrderId !== "string" || providerOrderId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_ORDER_ID });
        return;
    }

    const deal = await CreditDealPaymentQueryEngine.findByOrderId(providerOrderId);
    if (!deal)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.DEAL_NOT_FOUND });
        return;
    }

    // Verify against the provider that actually created the order (persisted on
    // the deal at create time), falling back to the configured default.
    const dealProviderEnum = deal.getPaymentProvider();
    const provider = dealProviderEnum !== null && dealProviderEnum !== undefined
        ? PaymentProviderFactory.getProvider(dealProviderEnum)
        : PaymentProviderFactory.getDefaultProvider();
    const verification = await provider.verifyPayment({ providerOrderId: providerOrderId, providerPaymentId: providerPaymentId, signature: signature });
    if (!verification.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PAYMENT_NOT_VERIFIED, reason: verification.reason });
        return;
    }

    const captureResult = await CreditDealPaymentQueryEngine.markCaptured(providerOrderId, providerPaymentId);

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        transitioned: captureResult.transitioned,
        deal: captureResult.deal ? captureResult.deal.toJson() : deal.toJson()
    });
}

module.exports = { verifyDealPayment };
