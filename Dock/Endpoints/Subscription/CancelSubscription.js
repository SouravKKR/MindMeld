const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const UserSubscriptionQueryEngine = require("../../Globals/Classes/Database/UserSubscriptionQueryEngine");
const PlanSubscriptionService = require("../../Globals/Classes/Plans/PlanSubscriptionService");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { subscriptionStatuses } = require("../../Globals/Enumerations/SubscriptionStatuses");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Subscription/Cancel
 *
 * Cancels the caller's subscription — at the end of the current paid cycle by
 * default (so access continues until planExpiresAt, then read-time expiry drops
 * the tier to FREE). planExpiresAt is never shortened here.
 *
 * Body: { cancelAtCycleEnd? }  (defaults to true)
 */
async function cancelSubscription(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const cancelAtCycleEnd = body?.cancelAtCycleEnd !== false;

    const subscription = await UserSubscriptionQueryEngine.getActiveByUserId(session.getUserId());
    if (!subscription || !subscription.getProviderSubscriptionId())
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUBSCRIPTION_NOT_FOUND });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    try
    {
        await provider.cancelSubscription(subscription.getProviderSubscriptionId(), cancelAtCycleEnd);
    }
    catch (cancelError)
    {
        console.error(`[CancelSubscription] cancel failed for ${subscription.getProviderSubscriptionId()}: ${cancelError?.message || cancelError}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.EXCEPTION });
        return;
    }

    // Mark not-renewing. Access continues until planExpiresAt regardless of
    // status; the subscription.cancelled webhook confirms the terminal state.
    await PlanSubscriptionService.applyStatus(subscription, subscriptionStatuses.CANCELLED);

    response.statusCode = httpStatus.OK;
    response.sendJson({ cancelled: true, cancelAtCycleEnd: cancelAtCycleEnd });
}

module.exports = { cancelSubscription };
