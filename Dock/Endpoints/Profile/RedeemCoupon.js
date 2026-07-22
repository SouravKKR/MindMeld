const { getUser } = require("../Helpers/GetUser");
const CouponQueryEngine = require("../../Globals/Classes/Database/CouponQueryEngine");
const Coupon = require("../../Globals/Classes/Coupons/Coupon");
const CouponRedemption = require("../../Globals/Classes/Coupons/CouponRedemption");
const CouponGrantService = require("../../Globals/Classes/Coupons/CouponGrantService");
const { couponRedemptionModes } = require("../../Globals/Enumerations/CouponRedemptionModes");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");

/**
 * POST /Profile/RedeemCoupon
 *
 * Redeems a STANDALONE coupon (grant credits / free plan / free deck) for the
 * logged-in user. Discount coupons (CREDIT_PURCHASE_DISCOUNT / PLAN_DISCOUNT)
 * are NOT redeemed here — they are applied at their checkout. The three
 * concurrency guards mirror RedeemPromoCode exactly:
 *
 *  1. claimRedemptionSlot atomically reserves a slot only while enabled and
 *     usedCount < maxRedemptions — the cap can never be exceeded.
 *  2. The unique (couponId, userId) index makes a second redemption by the same
 *     user impossible; a race loses (and releases) the slot it claimed.
 *  3. Credit grants are idempotent on `couponRedeem:{couponId}:{userId}`.
 *
 * Body: { codeString }
 */
async function redeemCoupon(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.sendJson({ error: ErrorCodes.INVALID_REQUEST });
        return;
    }

    const body = await request.getBody();
    const rawCodeString = body?.codeString;
    if (typeof rawCodeString !== "string" || rawCodeString.trim().length === 0 || rawCodeString.length > 128)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.INVALID_CODE });
        return;
    }

    const normalizedCodeString = Coupon.normalizeCodeString(rawCodeString);
    const userId = user.getId();
    const email = user.getAdditionalData()?.email || "";
    const nowMilliseconds = Date.now();

    const coupon = await CouponQueryEngine.getByCodeString(normalizedCodeString);
    if (!coupon)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.COUPON_NOT_FOUND });
        return;
    }

    if (!coupon.getEnabled())
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.COUPON_DISABLED });
        return;
    }

    // Discount coupons must be applied at their checkout, not redeemed standalone.
    if (coupon.getRedemptionMode() !== couponRedemptionModes.STANDALONE)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.COUPON_NOT_APPLICABLE });
        return;
    }

    // Redemption window (whether the code may still be redeemed) — distinct from
    // the benefit span (how long the grant lasts).
    if (!coupon.isWithinRedemptionWindow(nowMilliseconds))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.COUPON_WINDOW_CLOSED });
        return;
    }

    // Fast path — surface an already-used code before touching the cap counter.
    const existingRedemption = await CouponQueryEngine.findRedemption(coupon.getId(), userId);
    if (existingRedemption)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.COUPON_ALREADY_REDEEMED });
        return;
    }

    // Atomic cap gate.
    const claimedCoupon = await CouponQueryEngine.claimRedemptionSlot(coupon.getId());
    if (!claimedCoupon)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.COUPON_EXHAUSTED });
        return;
    }

    // Insert the redemption row first — it is the unique guard AND the audit
    // record. Grant-result details are backfilled after the grant.
    const redemption = new CouponRedemption
    ({
        couponId: coupon.getId(),
        codeString: coupon.getCodeString(),
        userId: userId,
        email: email,
        benefitTarget: coupon.getBenefitTarget(),
        benefitKind: coupon.getBenefitKind(),
        redeemedAt: new Date(nowMilliseconds)
    });

    const insertResult = await CouponQueryEngine.insertRedemption(redemption);
    if (!insertResult.inserted)
    {
        await CouponQueryEngine.releaseRedemptionSlot(coupon.getId());
        if (insertResult.alreadyRedeemed)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: ErrorCodes.COUPON_ALREADY_REDEEMED });
            return;
        }
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: ErrorCodes.DATABASE_UNAVAILABLE });
        return;
    }

    const grantResult = await CouponGrantService.applyStandaloneBenefit(user, coupon, nowMilliseconds);
    if (!grantResult.applied)
    {
        // The grant failed — undo the redemption row and release the slot so the
        // user can retry cleanly.
        await CouponQueryEngine.deleteRedemption(coupon.getId(), userId);
        await CouponQueryEngine.releaseRedemptionSlot(coupon.getId());
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: grantResult.reason || ErrorCodes.PERSIST_FAILED });
        return;
    }

    // Backfill the audit row with the grant result (deck license id, expiry, etc.).
    await CouponQueryEngine.updateRedemptionGrantResult(coupon.getId(), userId,
    {
        grantedCredits: grantResult.grantedCredits,
        grantedPlanTier: grantResult.grantedPlanTier,
        grantedDeckLicenseId: grantResult.grantedDeckLicenseId,
        benefitExpiresAt: grantResult.benefitExpiresAt,
        grantedSummary: grantResult.grantedSummary
    });

    response.statusCode = httpStatus.OK;
    response.sendJson
    ({
        success: true,
        benefitTarget: coupon.getBenefitTarget(),
        grantedSummary: grantResult.grantedSummary || "",
        grantedCredits: grantResult.grantedCredits ?? null,
        grantedPlanTier: grantResult.grantedPlanTier ?? null,
        benefitExpiresAt: grantResult.benefitExpiresAt ?? null
    });
}

module.exports = { redeemCoupon };
