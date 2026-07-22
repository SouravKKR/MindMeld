const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const UserSubscriptionQueryEngine = require("../../Globals/Classes/Database/UserSubscriptionQueryEngine");
const PlanSubscriptionService = require("../../Globals/Classes/Plans/PlanSubscriptionService");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Subscription/Verify
 *
 * Browser return leg after the buyer authorizes the mandate. Verifies the
 * subscription signature (paymentId|subscriptionId — reversed from one-time
 * orders) and activates the plan immediately so access is instant. Credits are
 * NOT granted here — they come only from the subscription.charged webhook, keyed
 * on the charge payment id, so verify + webhook never double-grant.
 *
 * Body: { providerSubscriptionId, providerPaymentId, signature }
 */
async function verifySubscription(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const providerSubscriptionId = body?.providerSubscriptionId;
    const providerPaymentId = body?.providerPaymentId;
    const signature = body?.signature;

    if (!providerSubscriptionId || !providerPaymentId || !signature)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const subscription = await UserSubscriptionQueryEngine.getByProviderSubscriptionId(providerSubscriptionId);
    if (!subscription)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUBSCRIPTION_NOT_FOUND });
        return;
    }

    // Re-authorize server-side: the subscription must belong to the caller.
    if (subscription.getUserId() !== session.getUserId())
    {
        response.statusCode = httpStatus.FORBIDDEN;
        response.sendJson({ error: ErrorCodes.ACCESS_NOT_ALLOWED });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    const verifyResult = await provider.verifySubscriptionPayment({ providerSubscriptionId, providerPaymentId, signature });
    if (!verifyResult.verified)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.PAYMENT_NOT_VERIFIED });
        return;
    }

    // Fetch the current period so entitlement is set immediately. Razorpay sends
    // UNIX SECONDS — convert to milliseconds. Non-fatal on failure: the webhook
    // sets the period authoritatively.
    let currentPeriodStartMs = null;
    let currentPeriodEndMs = null;
    try
    {
        const remoteSubscription = await provider.fetchSubscription(providerSubscriptionId);
        currentPeriodStartMs = remoteSubscription.current_start ? Number(remoteSubscription.current_start) * 1000 : null;
        currentPeriodEndMs = remoteSubscription.current_end ? Number(remoteSubscription.current_end) * 1000 : null;
    }
    catch (fetchError)
    {
        console.warn(`[VerifySubscription] Could not fetch period for ${providerSubscriptionId}: ${fetchError?.message || fetchError}`);
    }

    await PlanSubscriptionService.applyActivation(subscription, { currentPeriodStartMs: currentPeriodStartMs, currentPeriodEndMs: currentPeriodEndMs });

    response.statusCode = httpStatus.OK;
    response.sendJson({ verified: true, planTier: subscription.getPlanTier() });
}

module.exports = { verifySubscription };
