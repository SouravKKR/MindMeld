const { couponBenefitKinds } = require("../../Enumerations/CouponBenefitKinds");

// The single place coupon discount math lives, so a discount shown to the buyer
// and the discount actually charged can never diverge. Called by BOTH the
// credit-purchase pricing (CREDIT_PURCHASE_DISCOUNT) and the subscription
// pricing (PLAN_DISCOUNT). The kind semantics mirror OrganizationPerkResolver
// exactly: FULL_FREE → 0, FIXED_AMOUNT → subtract a minor amount, PERCENTAGE →
// subtract a clamped percentage. The result is always within [0, base].

class CouponResolver
{
    /**
     * @param {Coupon} coupon
     * @param {number} basePriceMinor — pre-discount price in integer minor units
     * @returns {number} the discounted price in integer minor units
     */
    static computeDiscountedPrice(coupon, basePriceMinor)
    {
        const base = Math.max(0, Math.floor(Number(basePriceMinor) || 0));
        const kind = Number(coupon.getBenefitKind());
        const value = Number(coupon.getBenefitValue()) || 0;

        if (kind === couponBenefitKinds.FULL_FREE)
        {
            return 0;
        }
        if (kind === couponBenefitKinds.FIXED_AMOUNT)
        {
            return Math.max(0, base - Math.floor(value));
        }
        if (kind === couponBenefitKinds.PERCENTAGE)
        {
            const clampedPercent = Math.max(0, Math.min(100, value));
            const discountMinor = Math.floor(base * clampedPercent / 100);
            return Math.max(0, base - discountMinor);
        }
        return base;
    }

    /**
     * The discount amount (base − discounted), in integer minor units.
     * @param {Coupon} coupon
     * @param {number} basePriceMinor
     * @returns {number}
     */
    static computeDiscountMinor(coupon, basePriceMinor)
    {
        const base = Math.max(0, Math.floor(Number(basePriceMinor) || 0));
        return base - CouponResolver.computeDiscountedPrice(coupon, basePriceMinor);
    }
}

module.exports = CouponResolver;
