const DurationConverter = require("../../../Globals/Classes/Plans/DurationConverter");
const PlanMetadata = require("../../../Globals/Classes/Plans/PlanMetadata");
const { couponBenefitTargets } = require("../../../Globals/Enumerations/CouponBenefitTargets");
const { couponBenefitKinds } = require("../../../Globals/Enumerations/CouponBenefitKinds");
const { billingCycleUnits } = require("../../../Globals/Enumerations/BillingCycleUnits");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

// Resolves an enum field that may arrive as a numeric value or a NAME string.
function resolveEnumValue(rawValue, enumObject)
{
    if (typeof rawValue === "number" && Object.values(enumObject).includes(rawValue))
    {
        return rawValue;
    }
    const byName = enumObject[String(rawValue ?? "").toUpperCase()];
    return byName !== undefined ? byName : null;
}

/**
 * Validates the shared coupon fields from an admin request body and returns a
 * template object (everything EXCEPT codeString) with the absolute redemption
 * window end computed in UTC ms. Both the single-create and bulk-create
 * endpoints use it. Returns { ok:true, template } or { ok:false, reason }.
 *
 * @param {object} body
 * @param {string} createdByUserId
 * @param {number} nowMilliseconds
 */
function buildCouponTemplate(body, createdByUserId, nowMilliseconds)
{
    const benefitTarget = resolveEnumValue(body?.benefitTarget, couponBenefitTargets);
    if (benefitTarget === null)
    {
        return { ok: false, reason: ErrorCodes.INVALID_BENEFIT_TARGET };
    }

    const benefitKind = resolveEnumValue(body?.benefitKind, couponBenefitKinds);
    if (benefitKind === null)
    {
        return { ok: false, reason: ErrorCodes.INVALID_BENEFIT_KIND };
    }

    const benefitValue = Number(body?.benefitValue);
    if (isNaN(benefitValue) || benefitValue < 0)
    {
        return { ok: false, reason: ErrorCodes.INVALID_BENEFIT_VALUE };
    }
    // The 0–100 ceiling only applies to a PERCENTAGE DISCOUNT. benefitKind is
    // meaningless for a grant target (GRANT_CREDITS uses benefitValue as a raw
    // credit count that legitimately exceeds 100), so it must not be range-checked
    // there — otherwise a "grant 500 credits" coupon is wrongly rejected.
    const targetIsDiscount = benefitTarget === couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT
        || benefitTarget === couponBenefitTargets.PLAN_DISCOUNT;
    if (targetIsDiscount && benefitKind === couponBenefitKinds.PERCENTAGE && benefitValue > 100)
    {
        return { ok: false, reason: ErrorCodes.INVALID_BENEFIT_VALUE };
    }

    const maxRedemptions = parseInt(body?.maxRedemptions, 10);
    if (isNaN(maxRedemptions) || maxRedemptions < 1)
    {
        return { ok: false, reason: ErrorCodes.INVALID_COUNT };
    }

    const redemptionWindowDurationValue = parseInt(body?.redemptionWindowDurationValue, 10);
    const safeWindowValue = (isNaN(redemptionWindowDurationValue) || redemptionWindowDurationValue < 0) ? 0 : redemptionWindowDurationValue;
    const redemptionWindowDurationUnit = resolveEnumValue(body?.redemptionWindowDurationUnit, billingCycleUnits);
    if (safeWindowValue > 0 && redemptionWindowDurationUnit === null)
    {
        return { ok: false, reason: ErrorCodes.INVALID_DURATION_UNIT };
    }

    const benefitSpanValue = parseInt(body?.benefitSpanValue, 10);
    const safeSpanValue = (isNaN(benefitSpanValue) || benefitSpanValue < 0) ? 0 : benefitSpanValue;
    const benefitSpanUnit = resolveEnumValue(body?.benefitSpanUnit, billingCycleUnits);
    if (safeSpanValue > 0 && benefitSpanUnit === null)
    {
        return { ok: false, reason: ErrorCodes.INVALID_DURATION_UNIT };
    }

    const targetPlanTier = (body?.targetPlanTier === null || body?.targetPlanTier === undefined || body?.targetPlanTier === "")
        ? null
        : Number(body.targetPlanTier);
    const targetDeckId = (typeof body?.targetDeckId === "string" && body.targetDeckId.length > 0) ? body.targetDeckId : null;
    const providerOfferId = (typeof body?.providerOfferId === "string" && body.providerOfferId.length > 0) ? body.providerOfferId : null;

    // Target-specific requirements.
    if (benefitTarget === couponBenefitTargets.GRANT_CREDITS && benefitValue <= 0)
    {
        return { ok: false, reason: ErrorCodes.INVALID_BENEFIT_VALUE };
    }
    if (benefitTarget === couponBenefitTargets.GRANT_FREE_PLAN)
    {
        if (targetPlanTier === null || !PlanMetadata.isPaidTier(targetPlanTier))
        {
            return { ok: false, reason: ErrorCodes.INVALID_PLAN_TIER };
        }
        if (safeSpanValue <= 0)
        {
            return { ok: false, reason: ErrorCodes.INVALID_DURATION_VALUE };
        }
    }
    if (benefitTarget === couponBenefitTargets.GRANT_FREE_DECK && targetDeckId === null)
    {
        return { ok: false, reason: ErrorCodes.MISSING_DECK_ID };
    }

    const redemptionWindowStartAt = nowMilliseconds;
    const redemptionWindowEndAt = safeWindowValue > 0
        ? DurationConverter.addDuration(redemptionWindowStartAt, safeWindowValue, redemptionWindowDurationUnit)
        : null;

    const template =
    {
        enabled: body?.enabled === undefined ? true : Boolean(body.enabled),
        maxRedemptions: maxRedemptions,
        usedCount: 0,
        redemptionWindowStartAt: redemptionWindowStartAt,
        redemptionWindowEndAt: redemptionWindowEndAt,
        redemptionWindowDurationValue: safeWindowValue,
        redemptionWindowDurationUnit: redemptionWindowDurationUnit === null ? billingCycleUnits.DAY : redemptionWindowDurationUnit,
        benefitSpanValue: safeSpanValue,
        benefitSpanUnit: benefitSpanUnit === null ? billingCycleUnits.MONTH : benefitSpanUnit,
        benefitTarget: benefitTarget,
        benefitKind: benefitKind,
        benefitValue: benefitValue,
        targetPlanTier: targetPlanTier,
        targetDeckId: targetDeckId,
        providerOfferId: providerOfferId,
        createdByUserId: createdByUserId,
        createdAt: new Date(nowMilliseconds)
    };

    return { ok: true, template: template };
}

module.exports = { buildCouponTemplate };
