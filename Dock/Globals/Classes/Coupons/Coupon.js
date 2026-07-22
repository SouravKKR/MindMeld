const crypto = require("crypto");
const { couponBenefitTargets } = require("../../Enumerations/CouponBenefitTargets");
const { couponBenefitKinds } = require("../../Enumerations/CouponBenefitKinds");
const { couponRedemptionModes } = require("../../Enumerations/CouponRedemptionModes");
const { billingCycleUnits } = require("../../Enumerations/BillingCycleUnits");
const { planTiers } = require("../../Enumerations/PlanTiers");
const DurationConverter = require("../Plans/DurationConverter");

// A single admin-issued coupon carrying exactly ONE benefit. The benefit is
// described by (benefitTarget, benefitKind, benefitValue) plus optional
// targetPlanTier / targetDeckId. Two independent durations:
//   - redemption window: until when the code may be redeemed (an absolute
//     redemptionWindowEndAt computed at create time, so the check is a single
//     comparison and never drifts with unit length).
//   - benefit span: how long a granted plan / free deck lasts.
// usedCount is the atomic race gate for maxRedemptions; the authoritative
// redeemer set lives in couponRedemptions (one row per user per coupon).

class Coupon
{
    #id;
    #codeString;
    #enabled;
    #maxRedemptions;
    #usedCount;
    #redemptionWindowStartAt;
    #redemptionWindowEndAt;
    #redemptionWindowDurationValue;
    #redemptionWindowDurationUnit;
    #benefitSpanValue;
    #benefitSpanUnit;
    #benefitTarget;
    #benefitKind;
    #benefitValue;
    #targetPlanTier;
    #targetDeckId;
    #providerOfferId;
    #createdByUserId;
    #createdAt;

    static DEFAULT_MAX_REDEMPTIONS = 1;

    constructor(fields = {})
    {
        this.setId(fields.id ?? null);
        this.setCodeString(fields.codeString ?? "");
        this.setEnabled(fields.enabled ?? true);
        this.setMaxRedemptions(fields.maxRedemptions ?? Coupon.DEFAULT_MAX_REDEMPTIONS);
        this.setUsedCount(fields.usedCount ?? 0);
        this.setRedemptionWindowStartAt(fields.redemptionWindowStartAt ?? null);
        this.setRedemptionWindowEndAt(fields.redemptionWindowEndAt ?? null);
        this.setRedemptionWindowDurationValue(fields.redemptionWindowDurationValue ?? 0);
        this.setRedemptionWindowDurationUnit(fields.redemptionWindowDurationUnit ?? billingCycleUnits.DAY);
        this.setBenefitSpanValue(fields.benefitSpanValue ?? 0);
        this.setBenefitSpanUnit(fields.benefitSpanUnit ?? billingCycleUnits.MONTH);
        this.setBenefitTarget(fields.benefitTarget ?? couponBenefitTargets.GRANT_CREDITS);
        this.setBenefitKind(fields.benefitKind ?? couponBenefitKinds.FIXED_AMOUNT);
        this.setBenefitValue(fields.benefitValue ?? 0);
        this.setTargetPlanTier(fields.targetPlanTier ?? null);
        this.setTargetDeckId(fields.targetDeckId ?? null);
        this.setProviderOfferId(fields.providerOfferId ?? null);
        this.setCreatedByUserId(fields.createdByUserId ?? "");
        this.setCreatedAt(fields.createdAt ?? null);
    }

    static normalizeCodeString(value)
    {
        return typeof value === "string" ? value.trim().toUpperCase() : String(value ?? "").trim().toUpperCase();
    }

    // STANDALONE benefits are redeemed on their own (grants); *_DISCOUNT benefits
    // are applied at a checkout. Derived from the target so the client knows
    // which flow to use.
    static deriveRedemptionMode(benefitTarget)
    {
        if (Number(benefitTarget) === couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT
            || Number(benefitTarget) === couponBenefitTargets.PLAN_DISCOUNT)
        {
            return couponRedemptionModes.AT_CHECKOUT;
        }
        return couponRedemptionModes.STANDALONE;
    }

    getId() { return this.#id; }
    setId(value) { this.#id = (value !== null && value !== undefined && value !== "") ? String(value) : crypto.randomUUID(); }

    getCodeString() { return this.#codeString; }
    setCodeString(value) { this.#codeString = Coupon.normalizeCodeString(value); }

    getEnabled() { return this.#enabled; }
    setEnabled(value) { this.#enabled = Boolean(value); }

    getMaxRedemptions() { return this.#maxRedemptions; }
    setMaxRedemptions(value)
    {
        const parsed = parseInt(value, 10);
        this.#maxRedemptions = (isNaN(parsed) || parsed < 1) ? 1 : parsed;
    }

    getUsedCount() { return this.#usedCount; }
    setUsedCount(value)
    {
        const parsed = parseInt(value, 10);
        this.#usedCount = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
    }

    getRedemptionWindowStartAt() { return this.#redemptionWindowStartAt; }
    setRedemptionWindowStartAt(value) { this.#redemptionWindowStartAt = Coupon.#toEpochOrNull(value); }

    getRedemptionWindowEndAt() { return this.#redemptionWindowEndAt; }
    setRedemptionWindowEndAt(value) { this.#redemptionWindowEndAt = Coupon.#toEpochOrNull(value); }

    getRedemptionWindowDurationValue() { return this.#redemptionWindowDurationValue; }
    setRedemptionWindowDurationValue(value)
    {
        const parsed = parseInt(value, 10);
        this.#redemptionWindowDurationValue = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
    }

    getRedemptionWindowDurationUnit() { return this.#redemptionWindowDurationUnit; }
    setRedemptionWindowDurationUnit(value) { this.#redemptionWindowDurationUnit = Coupon.#toUnit(value); }

    getBenefitSpanValue() { return this.#benefitSpanValue; }
    setBenefitSpanValue(value)
    {
        const parsed = parseInt(value, 10);
        this.#benefitSpanValue = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
    }

    getBenefitSpanUnit() { return this.#benefitSpanUnit; }
    setBenefitSpanUnit(value) { this.#benefitSpanUnit = Coupon.#toUnit(value); }

    getBenefitTarget() { return this.#benefitTarget; }
    setBenefitTarget(value) { this.#benefitTarget = Number(value); }

    getBenefitKind() { return this.#benefitKind; }
    setBenefitKind(value) { this.#benefitKind = Number(value); }

    getBenefitValue() { return this.#benefitValue; }
    setBenefitValue(value)
    {
        const parsed = Number(value);
        this.#benefitValue = (isNaN(parsed) || parsed < 0) ? 0 : parsed;
    }

    getTargetPlanTier() { return this.#targetPlanTier; }
    setTargetPlanTier(value)
    {
        if (value === null || value === undefined || value === "")
        {
            this.#targetPlanTier = null;
            return;
        }
        const numeric = Number(value);
        this.#targetPlanTier = Object.values(planTiers).includes(numeric) ? numeric : null;
    }

    getTargetDeckId() { return this.#targetDeckId; }
    setTargetDeckId(value) { this.#targetDeckId = (value === null || value === undefined || value === "") ? null : String(value); }

    // Razorpay Offer id — the native mechanism a PLAN_DISCOUNT coupon uses to
    // discount an auto-debit subscription (the plan amount itself is fixed).
    getProviderOfferId() { return this.#providerOfferId; }
    setProviderOfferId(value) { this.#providerOfferId = (value === null || value === undefined || value === "") ? null : String(value); }

    getCreatedByUserId() { return this.#createdByUserId; }
    setCreatedByUserId(value) { this.#createdByUserId = (value !== null && value !== undefined) ? String(value) : ""; }

    getCreatedAt() { return this.#createdAt; }
    setCreatedAt(value)
    {
        if (value !== null && value !== undefined)
        {
            const date = value instanceof Date ? value : new Date(value);
            this.#createdAt = isNaN(date.getTime()) ? null : date;
        }
        else
        {
            this.#createdAt = null;
        }
    }

    getRedemptionMode()
    {
        return Coupon.deriveRedemptionMode(this.#benefitTarget);
    }

    /**
     * Whether `now` falls inside the redemption window (start reached and end
     * not passed). Does NOT consider enabled / cap — the caller checks those
     * separately to surface distinct error codes.
     * @param {number} nowMilliseconds
     */
    isWithinRedemptionWindow(nowMilliseconds)
    {
        const afterStart = this.#redemptionWindowStartAt === null || nowMilliseconds >= this.#redemptionWindowStartAt;
        const beforeEnd = this.#redemptionWindowEndAt === null || nowMilliseconds <= this.#redemptionWindowEndAt;
        return afterStart && beforeEnd;
    }

    /**
     * The epoch-ms expiry of a granted plan / free deck for a redemption at
     * `now`, or null when the benefit span is zero (perpetual for a deck; not
     * applicable otherwise).
     * @param {number} nowMilliseconds
     */
    computeBenefitExpiresAt(nowMilliseconds)
    {
        if (this.#benefitSpanValue <= 0)
        {
            return null;
        }
        return DurationConverter.addDuration(nowMilliseconds, this.#benefitSpanValue, this.#benefitSpanUnit);
    }

    static #toEpochOrNull(value)
    {
        if (value === null || value === undefined)
        {
            return null;
        }
        if (value instanceof Date)
        {
            return value.getTime();
        }
        const numeric = Number(value);
        return isNaN(numeric) ? null : numeric;
    }

    static #toUnit(value)
    {
        const numeric = Number(value);
        return Object.values(billingCycleUnits).includes(numeric) ? numeric : billingCycleUnits.DAY;
    }

    toJson()
    {
        return {
            id: this.#id,
            codeString: this.#codeString,
            enabled: this.#enabled,
            maxRedemptions: this.#maxRedemptions,
            usedCount: this.#usedCount,
            redemptionWindowStartAt: this.#redemptionWindowStartAt,
            redemptionWindowEndAt: this.#redemptionWindowEndAt,
            redemptionWindowDurationValue: this.#redemptionWindowDurationValue,
            redemptionWindowDurationUnit: this.#redemptionWindowDurationUnit,
            benefitSpanValue: this.#benefitSpanValue,
            benefitSpanUnit: this.#benefitSpanUnit,
            benefitTarget: this.#benefitTarget,
            benefitKind: this.#benefitKind,
            benefitValue: this.#benefitValue,
            targetPlanTier: this.#targetPlanTier,
            targetDeckId: this.#targetDeckId,
            providerOfferId: this.#providerOfferId,
            redemptionMode: this.getRedemptionMode(),
            createdByUserId: this.#createdByUserId,
            createdAt: this.#createdAt
        };
    }

    static fromJson(json)
    {
        return new Coupon
        ({
            id: json?.id ?? null,
            codeString: json?.codeString ?? "",
            enabled: json?.enabled ?? true,
            maxRedemptions: json?.maxRedemptions ?? Coupon.DEFAULT_MAX_REDEMPTIONS,
            usedCount: json?.usedCount ?? 0,
            redemptionWindowStartAt: json?.redemptionWindowStartAt ?? null,
            redemptionWindowEndAt: json?.redemptionWindowEndAt ?? null,
            redemptionWindowDurationValue: json?.redemptionWindowDurationValue ?? 0,
            redemptionWindowDurationUnit: json?.redemptionWindowDurationUnit ?? billingCycleUnits.DAY,
            benefitSpanValue: json?.benefitSpanValue ?? 0,
            benefitSpanUnit: json?.benefitSpanUnit ?? billingCycleUnits.MONTH,
            benefitTarget: json?.benefitTarget ?? couponBenefitTargets.GRANT_CREDITS,
            benefitKind: json?.benefitKind ?? couponBenefitKinds.FIXED_AMOUNT,
            benefitValue: json?.benefitValue ?? 0,
            targetPlanTier: json?.targetPlanTier ?? null,
            targetDeckId: json?.targetDeckId ?? null,
            providerOfferId: json?.providerOfferId ?? null,
            createdByUserId: json?.createdByUserId ?? "",
            createdAt: json?.createdAt ?? null
        });
    }
}

module.exports = Coupon;
