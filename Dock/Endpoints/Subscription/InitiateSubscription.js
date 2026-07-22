const { createUserSubscription } = require("./SubscriptionInitiationHelper");
const RegionResolver = require("../../Globals/Classes/Pricing/RegionResolver");
const RegionMetadata = require("../../Globals/Classes/Pricing/RegionMetadata");
const PlanMetadata = require("../../Globals/Classes/Plans/PlanMetadata");
const CouponCheckoutService = require("../../Globals/Classes/Coupons/CouponCheckoutService");
const { getUser } = require("../Helpers/GetUser");
const { planTiers } = require("../../Globals/Enumerations/PlanTiers");
const { couponBenefitTargets } = require("../../Globals/Enumerations/CouponBenefitTargets");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");

/**
 * POST /Subscription/Initiate
 *
 * Starts a Razorpay auto-debit subscription for a paid plan tier. The client
 * sends only the tier (plus optional region hints and a PLAN_DISCOUNT
 * couponCode); the price and Razorpay Plan are resolved server-side. Returns
 * the subscription id and shortUrl the browser opens to authorize the
 * e-mandate. Credits and entitlement are applied later by the verify leg and
 * the subscription.charged webhook.
 *
 * A PLAN_DISCOUNT coupon is delivered through its Razorpay Offer id (the plan
 * amount itself is fixed), reserved once-per-user and released if the
 * subscription cannot be created.
 *
 * Body: { planTier, region?, localeRegionHint?, couponCode? }
 */
async function initiateSubscription(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const planTier = typeof body?.planTier === "number"
        ? body.planTier
        : planTiers[String(body?.planTier || "").toUpperCase()];

    if (planTier === undefined || planTier === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_PLAN_TIER });
        return;
    }

    // Optional PLAN_DISCOUNT coupon. Reserved before the subscription is created
    // so its Razorpay Offer id can be passed to Razorpay; released below if the
    // subscription cannot be created.
    let appliedCouponId = null;
    let providerOfferId = null;
    const rawCouponCode = typeof body?.couponCode === "string" ? body.couponCode.trim() : "";
    if (rawCouponCode.length > 0)
    {
        const region = RegionResolver.resolveRegion(request, (body?.region || "").toUpperCase() || null, (body?.localeRegionHint || "").toUpperCase() || null);
        const currency = RegionMetadata.getDisplayCurrency(region);
        const planPriceMinor = PlanMetadata.getPriceMinor(planTier, currency) || 0;

        const buyer = await getUser(request);
        const buyerEmail = buyer?.getAdditionalData()?.email || "";
        const couponResult = await CouponCheckoutService.resolveAndReserve
        (
            session.getUserId(),
            buyerEmail,
            rawCouponCode,
            planPriceMinor,
            couponBenefitTargets.PLAN_DISCOUNT,
            Date.now()
        );
        if (!couponResult.ok)
        {
            response.statusCode = couponResult.statusCode;
            response.sendJson({ error: couponResult.reason });
            return;
        }

        providerOfferId = couponResult.coupon.getProviderOfferId();
        if (!providerOfferId)
        {
            // A plan-discount coupon with no Razorpay Offer id cannot discount an
            // auto-debit subscription — release and reject rather than charge full
            // price silently. (Use a GRANT_FREE_PLAN coupon for offer-less deals.)
            await CouponCheckoutService.release(couponResult.coupon.getId(), session.getUserId());
            response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
            response.sendJson({ error: ErrorCodes.SUBSCRIPTION_NOT_CONFIGURED });
            return;
        }
        appliedCouponId = couponResult.coupon.getId();
    }

    const result = await createUserSubscription(request, session, planTier, { providerOfferId: providerOfferId, appliedCouponId: appliedCouponId });
    if (!result.ok)
    {
        if (appliedCouponId)
        {
            await CouponCheckoutService.release(appliedCouponId, session.getUserId());
        }
        response.statusCode = result.statusCode;
        response.sendJson({ error: result.error });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson(result.payload);
}

module.exports = { initiateSubscription };
