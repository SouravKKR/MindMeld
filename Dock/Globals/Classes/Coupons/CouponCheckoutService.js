const CouponQueryEngine = require("../Database/CouponQueryEngine");
const CouponRedemption = require("./CouponRedemption");
const CouponResolver = require("./CouponResolver");
const { couponRedemptionModes } = require("../../Enumerations/CouponRedemptionModes");
const { couponBenefitTargets } = require("../../Enumerations/CouponBenefitTargets");
const { httpStatus } = require("../../Enumerations/HttpStatus");
const ErrorCodes = require("../../Constants/ErrorCodes");

// Applies an AT_CHECKOUT discount coupon (CREDIT_PURCHASE_DISCOUNT /
// PLAN_DISCOUNT) to a base price, reserving it with the SAME three guards as a
// standalone redemption: atomic slot claim, unique (couponId, userId) row, and
// (for the caller) a release path when the checkout it feeds fails to launch.
// The discount is a once-per-user use bounded by the coupon's global cap.

class CouponCheckoutService
{
    /**
     * Validates and reserves a discount coupon for a user, returning the
     * discounted price. On any validation failure nothing is reserved. On
     * success the caller MUST call release() if the downstream order cannot be
     * created (so an unlaunched checkout does not burn the user's use).
     *
     * @param {string} userId
     * @param {string} email
     * @param {string} codeString
     * @param {number} basePriceMinor
     * @param {number} expectedBenefitTarget — the CouponBenefitTargets value this checkout accepts
     * @param {number} nowMilliseconds
     * @returns {Promise<{ok: boolean, statusCode?: number, reason?: string, coupon?: Coupon, discountedMinor?: number, discountMinor?: number}>}
     */
    static async resolveAndReserve(userId, email, codeString, basePriceMinor, expectedBenefitTarget, nowMilliseconds)
    {
        const coupon = await CouponQueryEngine.getByCodeString(codeString);
        if (!coupon)
        {
            return { ok: false, statusCode: httpStatus.NOT_FOUND, reason: ErrorCodes.COUPON_NOT_FOUND };
        }
        if (!coupon.getEnabled())
        {
            return { ok: false, statusCode: httpStatus.BAD_REQUEST, reason: ErrorCodes.COUPON_DISABLED };
        }
        if (Number(coupon.getBenefitTarget()) !== Number(expectedBenefitTarget)
            || coupon.getRedemptionMode() !== couponRedemptionModes.AT_CHECKOUT)
        {
            return { ok: false, statusCode: httpStatus.BAD_REQUEST, reason: ErrorCodes.COUPON_NOT_APPLICABLE };
        }
        if (!coupon.isWithinRedemptionWindow(nowMilliseconds))
        {
            return { ok: false, statusCode: httpStatus.BAD_REQUEST, reason: ErrorCodes.COUPON_WINDOW_CLOSED };
        }

        const existingRedemption = await CouponQueryEngine.findRedemption(coupon.getId(), userId);
        if (existingRedemption)
        {
            return { ok: false, statusCode: httpStatus.BAD_REQUEST, reason: ErrorCodes.COUPON_ALREADY_REDEEMED };
        }

        const claimedCoupon = await CouponQueryEngine.claimRedemptionSlot(coupon.getId());
        if (!claimedCoupon)
        {
            return { ok: false, statusCode: httpStatus.BAD_REQUEST, reason: ErrorCodes.COUPON_EXHAUSTED };
        }

        const discountedMinor = CouponResolver.computeDiscountedPrice(coupon, basePriceMinor);
        const discountMinor = CouponResolver.computeDiscountMinor(coupon, basePriceMinor);

        // For a PLAN_DISCOUNT the real reduction is applied by Razorpay via the
        // coupon's Offer id (the plan amount is fixed), so the coupon-value math
        // is NOT authoritative — record it as an offer reference rather than a
        // concrete minor amount that could misstate the audit.
        const isPlanDiscount = Number(expectedBenefitTarget) === couponBenefitTargets.PLAN_DISCOUNT;

        const redemption = new CouponRedemption
        ({
            couponId: coupon.getId(),
            codeString: coupon.getCodeString(),
            userId: userId,
            email: email,
            benefitTarget: coupon.getBenefitTarget(),
            benefitKind: coupon.getBenefitKind(),
            discountAppliedMinor: isPlanDiscount ? null : discountMinor,
            grantedSummary: isPlanDiscount
                ? `Plan discount via Razorpay offer ${coupon.getProviderOfferId() || ""}`.trim()
                : `Discount ${discountMinor} minor on checkout`,
            redeemedAt: new Date(nowMilliseconds)
        });

        const insertResult = await CouponQueryEngine.insertRedemption(redemption);
        if (!insertResult.inserted)
        {
            await CouponQueryEngine.releaseRedemptionSlot(coupon.getId());
            const reason = insertResult.alreadyRedeemed ? ErrorCodes.COUPON_ALREADY_REDEEMED : ErrorCodes.DATABASE_UNAVAILABLE;
            const statusCode = insertResult.alreadyRedeemed ? httpStatus.BAD_REQUEST : httpStatus.INTERNAL_SERVER_ERROR;
            return { ok: false, statusCode: statusCode, reason: reason };
        }

        return { ok: true, coupon: coupon, discountedMinor: discountedMinor, discountMinor: discountMinor };
    }

    /**
     * Undoes a reservation from resolveAndReserve — deletes the redemption row
     * and returns the slot. Call when the checkout the reservation fed could not
     * be launched.
     * @param {string} couponId
     * @param {string} userId
     */
    static async release(couponId, userId)
    {
        if (!couponId || !userId)
        {
            return;
        }
        await CouponQueryEngine.deleteRedemption(couponId, userId);
        await CouponQueryEngine.releaseRedemptionSlot(couponId);
    }
}

module.exports = CouponCheckoutService;
