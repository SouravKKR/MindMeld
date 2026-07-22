const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const PaymentProviderFactory = require("../../Globals/Classes/Payments/PaymentProviderFactory");
const RazorpayPlanRegistry = require("../../Globals/Classes/Payments/RazorpayPlanRegistry");
const UserSubscription = require("../../Globals/Classes/Plans/UserSubscription");
const UserSubscriptionQueryEngine = require("../../Globals/Classes/Database/UserSubscriptionQueryEngine");
const PlanMetadata = require("../../Globals/Classes/Plans/PlanMetadata");
const { getUser } = require("../Helpers/GetUser");
const { paymentProviders } = require("../../Globals/Enumerations/PaymentProviders");
const { subscriptionStatuses } = require("../../Globals/Enumerations/SubscriptionStatuses");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * Creates a Razorpay subscription for a user at a paid tier and records the
 * CREATED UserSubscription row. Shared by /Subscription/Initiate and the
 * upgrade path of /Subscription/Change. Returns a result the caller turns into
 * an HTTP response — it never writes to `response` itself.
 *
 * @returns {Promise<{ok: boolean, statusCode?: number, error?: string, payload?: object, subscription?: UserSubscription}>}
 */
async function createUserSubscription(request, session, planTier, options = {})
{
    if (!PlanMetadata.isPaidTier(planTier))
    {
        return { ok: false, statusCode: httpStatus.BAD_REQUEST, error: ErrorCodes.INVALID_PLAN_TIER };
    }

    const body = await request.getBody();
    const region = RegionResolver.resolveRegion
    (
        request,
        (body?.region || "").toUpperCase() || null,
        (body?.localeRegionHint || "").toUpperCase() || null
    );
    const currency = RegionMetadata.getDisplayCurrency(region);

    const priceMinor = PlanMetadata.getPriceMinor(planTier, currency);
    if (typeof priceMinor !== "number" || priceMinor <= 0)
    {
        return { ok: false, statusCode: httpStatus.SERVICE_UNAVAILABLE, error: ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED };
    }

    const provider = PaymentProviderFactory.getProvider(paymentProviders.RAZORPAY);
    if (!provider || !provider.isConfigured() || !provider.supportsRecurringSubscriptions())
    {
        return { ok: false, statusCode: httpStatus.SERVICE_UNAVAILABLE, error: ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED };
    }

    let providerPlanId;
    try
    {
        const planResult = await RazorpayPlanRegistry.getOrCreatePlanId(planTier, currency);
        providerPlanId = planResult.providerPlanId;
    }
    catch (planError)
    {
        return { ok: false, statusCode: httpStatus.SERVICE_UNAVAILABLE, error: planError.reason || ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED };
    }

    let subscriptionResult;
    try
    {
        subscriptionResult = await provider.createSubscription
        ({
            providerPlanId: providerPlanId,
            notes: { userId: session.getUserId(), planTier: String(planTier) },
            offerId: options.providerOfferId || undefined
        });
    }
    catch (subscriptionError)
    {
        console.error(`[SubscriptionInitiation] createSubscription failed for ${session.getUserId()}: ${subscriptionError?.message || subscriptionError}`);
        return { ok: false, statusCode: httpStatus.BAD_GATEWAY, error: ErrorCodes.EXCEPTION };
    }

    const user = await getUser(request);
    const email = user?.getAdditionalData()?.email || "";

    const subscriptionRecord = new UserSubscription
    ({
        userId: session.getUserId(),
        email: email,
        planTier: planTier,
        currency: currency,
        providerSubscriptionId: subscriptionResult.providerSubscriptionId,
        providerPlanId: providerPlanId,
        status: subscriptionStatuses.CREATED,
        appliedCouponId: options.appliedCouponId ?? null
    });
    await UserSubscriptionQueryEngine.create(subscriptionRecord);

    return {
        ok: true,
        subscription: subscriptionRecord,
        payload:
        {
            providerSubscriptionId: subscriptionResult.providerSubscriptionId,
            shortUrl: subscriptionResult.shortUrl,
            keyId: provider.getPublicKeyId(),
            planTier: planTier,
            currency: currency,
            amountMinor: priceMinor
        }
    };
}

module.exports = { createUserSubscription };
