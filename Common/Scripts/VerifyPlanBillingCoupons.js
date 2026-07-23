// Standalone verification harness for the plan-tier / recurring-billing / coupon
// feature. Exercises the pure (no-DB) logic end to end and exits non-zero on the
// first failed assertion. Run with:  node Common/Scripts/VerifyPlanBillingCoupons.js
//
// Covers the correctness traps called out in the plan: read-time plan expiry,
// coupon discount math + clamping, UTC duration arithmetic, the REVERSED
// Razorpay subscription signature, and coupon redemption-mode derivation.

const assert = require("assert");

const PlanMetadata = require("../../Dock/Globals/Classes/Plans/PlanMetadata");
const PlanTierResolver = require("../../Dock/Globals/Classes/Plans/PlanTierResolver");
const StorageQuotaEnforcer = require("../../Dock/Globals/Classes/Storage/StorageQuotaEnforcer");
const CouponResolver = require("../../Dock/Globals/Classes/Coupons/CouponResolver");
const DurationConverter = require("../../Dock/Globals/Classes/Plans/DurationConverter");
const Coupon = require("../../Dock/Globals/Classes/Coupons/Coupon");
const { buildCouponTemplate } = require("../../Dock/Endpoints/Admin/Coupons/CouponAdminHelper");
const User = require("../../Dock/Globals/Model/User");
const RazorpayPaymentProvider = require("../../Dock/Globals/Classes/Payments/RazorpayPaymentProvider");
const SubscriptionWebhookProcessor = require("../../Dock/Globals/Classes/Plans/SubscriptionWebhookProcessor");
const crypto = require("crypto");

const { planTiers } = require("../../Dock/Globals/Enumerations/PlanTiers");
const { planFeatures } = require("../../Dock/Globals/Enumerations/PlanFeatures");
const { couponBenefitTargets } = require("../../Dock/Globals/Enumerations/CouponBenefitTargets");
const { couponBenefitKinds } = require("../../Dock/Globals/Enumerations/CouponBenefitKinds");
const { couponRedemptionModes } = require("../../Dock/Globals/Enumerations/CouponRedemptionModes");
const { billingCycleUnits } = require("../../Dock/Globals/Enumerations/BillingCycleUnits");

let passed = 0;
function check(description, condition)
{
    assert.ok(condition, `FAILED: ${description}`);
    passed++;
}

// ── PlanMetadata: per-tier limits + feature gating ─────────────────────────
check("Free storage is 20 MB", PlanMetadata.getStorageBytes(planTiers.FREE) === 20 * 1024 * 1024);
check("Pro Plus storage is 2 GB", PlanMetadata.getStorageBytes(planTiers.PRO_PLUS) === 2 * 1024 * 1024 * 1024);
check("Free allows 2 devices", PlanMetadata.getMaxDevices(planTiers.FREE) === 2);
check("Pro Plus allows 6 devices", PlanMetadata.getMaxDevices(planTiers.PRO_PLUS) === 6);
check("Basic grants 25 monthly credits", PlanMetadata.getMonthlyCredits(planTiers.BASIC) === 25);
check("Basic price is 19900 INR minor", PlanMetadata.getPriceMinor(planTiers.BASIC, "INR") === 19900);
check("Free has no INR price", PlanMetadata.getPriceMinor(planTiers.FREE, "INR") === null);
check("Free has ASK_AI", PlanMetadata.hasFeature(planTiers.FREE, planFeatures.ASK_AI));
check("Free lacks generation", !PlanMetadata.hasFeature(planTiers.FREE, planFeatures.AUTOMATIC_GENERATION));
check("Pro has generation", PlanMetadata.hasFeature(planTiers.PRO, planFeatures.AUTOMATIC_GENERATION));
check("Pro lacks image generation", !PlanMetadata.hasFeature(planTiers.PRO, planFeatures.IMAGE_GENERATION));
check("Pro Plus has image generation", PlanMetadata.hasFeature(planTiers.PRO_PLUS, planFeatures.IMAGE_GENERATION));
check("Pro Plus has monthly free deck", PlanMetadata.hasFeature(planTiers.PRO_PLUS, planFeatures.MONTHLY_FREE_DECK));
check("Basic mock-eval is Basic+", PlanMetadata.hasFeature(planTiers.BASIC, planFeatures.MOCK_TEST_EVALUATION) && !PlanMetadata.hasFeature(planTiers.FREE, planFeatures.MOCK_TEST_EVALUATION));

// Admin feature-access override applies then clears.
PlanMetadata.applyFeatureAccessOverride({ FREE: ["ASK_AI", "CHAT", "AUTOMATIC_GENERATION"] });
check("override unlocks generation for Free", PlanMetadata.hasFeature(planTiers.FREE, planFeatures.AUTOMATIC_GENERATION));
PlanMetadata.clearFeatureAccessOverride();
check("clearing override restores defaults", !PlanMetadata.hasFeature(planTiers.FREE, planFeatures.AUTOMATIC_GENERATION));

// ── StorageQuotaEnforcer: combined-budget at-the-cap decision ──────────────
// Uploads now share the single plan cap with deck content, so the upload
// pre-check compares (used + fileSize) against the limit. Exercise the pure
// boundary logic — the risky part is the at-cap edge and a bad file size.
const twentyMegabytes = 20 * 1024 * 1024;
check("upload that stays under cap fits", StorageQuotaEnforcer.fitsWithinLimit(10 * 1024 * 1024, 5 * 1024 * 1024, twentyMegabytes));
check("upload exactly filling the cap fits", StorageQuotaEnforcer.fitsWithinLimit(15 * 1024 * 1024, 5 * 1024 * 1024, twentyMegabytes));
check("upload one byte over the cap is refused", !StorageQuotaEnforcer.fitsWithinLimit(15 * 1024 * 1024, 5 * 1024 * 1024 + 1, twentyMegabytes));
check("already over cap refuses any growth", !StorageQuotaEnforcer.fitsWithinLimit(twentyMegabytes + 1, 0, twentyMegabytes));
check("negative addition treated as zero (used==limit still fits)", StorageQuotaEnforcer.fitsWithinLimit(twentyMegabytes, -100, twentyMegabytes));
check("non-finite file size treated as zero", StorageQuotaEnforcer.fitsWithinLimit(5 * 1024 * 1024, NaN, twentyMegabytes));

// ── PlanTierResolver: read-time expiry ─────────────────────────────────────
const future = Date.now() + 86400000;
const past = Date.now() - 86400000;
check("active Pro resolves to Pro", PlanTierResolver.getEffectiveTier(User.fromJson({ id: "a", additionalData: { plan: planTiers.PRO, planExpiresAt: future } })) === planTiers.PRO);
check("lapsed Pro resolves to Free", PlanTierResolver.getEffectiveTier(User.fromJson({ id: "b", additionalData: { plan: planTiers.PRO, planExpiresAt: past } })) === planTiers.FREE);
check("lapsed Pro still stored as Pro", PlanTierResolver.getStoredTier(User.fromJson({ id: "c", additionalData: { plan: planTiers.PRO, planExpiresAt: past } })) === planTiers.PRO);
check("no plan resolves to Free", PlanTierResolver.getEffectiveTier(User.fromJson({ id: "d", additionalData: {} })) === planTiers.FREE);

// ── CouponResolver: discount math + clamping ───────────────────────────────
const pct40 = new Coupon({ benefitKind: couponBenefitKinds.PERCENTAGE, benefitValue: 40 });
const fixed250 = new Coupon({ benefitKind: couponBenefitKinds.FIXED_AMOUNT, benefitValue: 250 });
const fixedHuge = new Coupon({ benefitKind: couponBenefitKinds.FIXED_AMOUNT, benefitValue: 5000 });
const fullFree = new Coupon({ benefitKind: couponBenefitKinds.FULL_FREE });
check("40% off 1000 = 600", CouponResolver.computeDiscountedPrice(pct40, 1000) === 600);
check("fixed 250 off 1000 = 750", CouponResolver.computeDiscountedPrice(fixed250, 1000) === 750);
check("fixed over-value clamps to 0", CouponResolver.computeDiscountedPrice(fixedHuge, 1000) === 0);
check("full free = 0", CouponResolver.computeDiscountedPrice(fullFree, 1000) === 0);
check("discount amount is base - discounted", CouponResolver.computeDiscountMinor(pct40, 1000) === 400);

// ── DurationConverter: UTC arithmetic ──────────────────────────────────────
check("+7 days", DurationConverter.addDuration(Date.UTC(2026, 0, 1), 7, billingCycleUnits.DAY) === Date.UTC(2026, 0, 8));
check("+1 month", DurationConverter.addDuration(Date.UTC(2026, 0, 1), 1, billingCycleUnits.MONTH) === Date.UTC(2026, 1, 1));
check("+1 year", DurationConverter.addDuration(Date.UTC(2026, 0, 1), 1, billingCycleUnits.YEAR) === Date.UTC(2027, 0, 1));
check("zero value is a no-op", DurationConverter.addDuration(Date.UTC(2026, 0, 1), 0, billingCycleUnits.MONTH) === Date.UTC(2026, 0, 1));

// ── Coupon: redemption mode + window + roundtrip ───────────────────────────
check("grant-credits is standalone", Coupon.deriveRedemptionMode(couponBenefitTargets.GRANT_CREDITS) === couponRedemptionModes.STANDALONE);
check("plan-discount is at-checkout", Coupon.deriveRedemptionMode(couponBenefitTargets.PLAN_DISCOUNT) === couponRedemptionModes.AT_CHECKOUT);
const windowed = new Coupon({ redemptionWindowStartAt: 1000, redemptionWindowEndAt: 2000 });
check("inside window", windowed.isWithinRedemptionWindow(1500));
check("after window closes", !windowed.isWithinRedemptionWindow(2500));
const offerCoupon = Coupon.fromJson(new Coupon({ codeString: "x", providerOfferId: "offer_123", benefitTarget: couponBenefitTargets.PLAN_DISCOUNT }).toJson());
check("providerOfferId round-trips", offerCoupon.getProviderOfferId() === "offer_123");
const spanCoupon = new Coupon({ benefitSpanValue: 3, benefitSpanUnit: billingCycleUnits.MONTH });
check("benefit expiry computed from span", spanCoupon.computeBenefitExpiresAt(Date.UTC(2026, 0, 1)) === Date.UTC(2026, 3, 1));

// ── Admin coupon validation (buildCouponTemplate) ──────────────────────────
// Regression for the bug where a GRANT_CREDITS coupon > 100 credits was wrongly
// rejected by the PERCENTAGE 0-100 ceiling (the panel hides the kind field and
// defaults it to PERCENTAGE for grants).
const nowForTemplate = 1770000000000;
const grant500 = buildCouponTemplate({ benefitTarget: couponBenefitTargets.GRANT_CREDITS, benefitKind: couponBenefitKinds.PERCENTAGE, benefitValue: 500, maxRedemptions: 100 }, "admin", nowForTemplate);
check("GRANT_CREDITS 500 accepted despite PERCENTAGE kind", grant500.ok === true && grant500.template.benefitValue === 500);
const badPercent = buildCouponTemplate({ benefitTarget: couponBenefitTargets.CREDIT_PURCHASE_DISCOUNT, benefitKind: couponBenefitKinds.PERCENTAGE, benefitValue: 150, maxRedemptions: 1 }, "admin", nowForTemplate);
check("PERCENTAGE discount 150 rejected", badPercent.ok === false);
const freePlanNoTier = buildCouponTemplate({ benefitTarget: couponBenefitTargets.GRANT_FREE_PLAN, benefitKind: couponBenefitKinds.FULL_FREE, benefitValue: 0, maxRedemptions: 1, benefitSpanValue: 3, benefitSpanUnit: billingCycleUnits.MONTH }, "admin", nowForTemplate);
check("GRANT_FREE_PLAN without tier rejected", freePlanNoTier.ok === false);
const freeProGood = buildCouponTemplate({ benefitTarget: couponBenefitTargets.GRANT_FREE_PLAN, benefitKind: couponBenefitKinds.FULL_FREE, benefitValue: 0, maxRedemptions: 5, targetPlanTier: planTiers.PRO, benefitSpanValue: 3, benefitSpanUnit: billingCycleUnits.MONTH, redemptionWindowDurationValue: 30, redemptionWindowDurationUnit: billingCycleUnits.DAY }, "admin", nowForTemplate);
check("free Pro 3mo with 30d window accepted + window end computed", freeProGood.ok === true && freeProGood.template.redemptionWindowEndAt !== null);

// ── Razorpay: REVERSED subscription signature ──────────────────────────────
const provider = new RazorpayPaymentProvider();
provider.constructor; // keep reference
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "test";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "verify_secret";
const verifyProvider = new RazorpayPaymentProvider();
const subscriptionId = "sub_ABC";
const paymentId = "pay_XYZ";
const correctSignature = crypto.createHmac("sha256", "verify_secret").update(`${paymentId}|${subscriptionId}`).digest("hex");
const orderStyleSignature = crypto.createHmac("sha256", "verify_secret").update(`${subscriptionId}|${paymentId}`).digest("hex");

// ── Webhook: subscription-event detection ──────────────────────────────────
check("subscription.charged is a subscription event", SubscriptionWebhookProcessor.isSubscriptionEvent("subscription.charged"));
check("payment.captured is NOT a subscription event", !SubscriptionWebhookProcessor.isSubscriptionEvent("payment.captured"));

async function runAsyncChecks()
{
    const good = await verifyProvider.verifySubscriptionPayment({ providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, signature: correctSignature });
    check("reversed (paymentId|subscriptionId) signature verifies", good.verified === true);
    const bad = await verifyProvider.verifySubscriptionPayment({ providerSubscriptionId: subscriptionId, providerPaymentId: paymentId, signature: orderStyleSignature });
    check("order-style signature is rejected for subscriptions", bad.verified === false);

    console.log(`\nVerifyPlanBillingCoupons: all ${passed} checks passed.`);
}

runAsyncChecks().catch((error) =>
{
    console.error(error.message || error);
    process.exit(1);
});
