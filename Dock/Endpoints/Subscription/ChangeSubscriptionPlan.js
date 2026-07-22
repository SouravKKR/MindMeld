const { createUserSubscription } = require("./SubscriptionInitiationHelper");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const UserSubscriptionQueryEngine = require("../../Globals/Classes/Database/UserSubscriptionQueryEngine");
const PlanSubscriptionService = require("../../Globals/Classes/Plans/PlanSubscriptionService");
const PlanMetadata = require("../../Globals/Classes/Plans/PlanMetadata");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { planTiers } = require("../../Globals/Enumerations/PlanTiers");
const { subscriptionStatuses } = require("../../Globals/Enumerations/SubscriptionStatuses");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Subscription/Change
 *
 * Upgrade: create a new subscription at the higher tier now and cancel the old
 * one immediately — the client authorizes the new mandate via the returned
 * shortUrl. (Razorpay cannot hot-swap a mandate onto a new plan.)
 *
 * Downgrade: cancel the current subscription at cycle end and record the
 * intended lower tier. Access stays at the current tier until planExpiresAt,
 * then read-time expiry drops it to FREE; a downgrade to a lower PAID tier
 * requires the user to start that subscription afterward.
 *
 * Body: { planTier, region?, localeRegionHint? }
 */
async function changeSubscriptionPlan(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const targetTier = typeof body?.planTier === "number"
        ? body.planTier
        : planTiers[String(body?.planTier || "").toUpperCase()];

    if (targetTier === undefined || targetTier === null || !PlanMetadata.isValidTier(targetTier))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_PLAN_TIER });
        return;
    }

    const currentSubscription = await UserSubscriptionQueryEngine.getActiveByUserId(session.getUserId());
    if (!currentSubscription || !currentSubscription.getProviderSubscriptionId())
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.SUBSCRIPTION_NOT_FOUND });
        return;
    }

    const currentTier = currentSubscription.getPlanTier();
    if (Number(targetTier) === Number(currentTier))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_PLAN_TIER });
        return;
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);

    if (Number(targetTier) > Number(currentTier))
    {
        // UPGRADE — create the new (higher) subscription first; only cancel the
        // old one once the new one is safely created, so a failure never leaves
        // the user with no subscription.
        const result = await createUserSubscription(request, session, targetTier);
        if (!result.ok)
        {
            response.statusCode = result.statusCode;
            response.sendJson({ error: result.error });
            return;
        }

        try
        {
            await provider.cancelSubscription(currentSubscription.getProviderSubscriptionId(), false);
            await PlanSubscriptionService.applyStatus(currentSubscription, subscriptionStatuses.CANCELLED);
        }
        catch (cancelError)
        {
            console.error(`[ChangeSubscriptionPlan] Failed to cancel old subscription ${currentSubscription.getProviderSubscriptionId()}: ${cancelError?.message || cancelError}`);
        }

        response.statusCode = httpStatus.OK;
        response.sendJson({ ...result.payload, changeType: "UPGRADE" });
        return;
    }

    // DOWNGRADE — cancel at cycle end and record the intended tier. The user
    // keeps the current tier until planExpiresAt.
    try
    {
        await provider.cancelSubscription(currentSubscription.getProviderSubscriptionId(), true);
    }
    catch (cancelError)
    {
        console.error(`[ChangeSubscriptionPlan] Downgrade cancel failed for ${currentSubscription.getProviderSubscriptionId()}: ${cancelError?.message || cancelError}`);
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.EXCEPTION });
        return;
    }

    await UserSubscriptionQueryEngine.patchByProviderSubscriptionId
    (
        currentSubscription.getProviderSubscriptionId(),
        { status: subscriptionStatuses.CANCELLED, pendingDowngradeTier: targetTier }
    );
    await PlanSubscriptionService.applyStatus(currentSubscription, subscriptionStatuses.CANCELLED);

    response.statusCode = httpStatus.OK;
    response.sendJson({ changeType: "DOWNGRADE", downgradeScheduled: true, targetTier: Number(targetTier) });
}

module.exports = { changeSubscriptionPlan };
