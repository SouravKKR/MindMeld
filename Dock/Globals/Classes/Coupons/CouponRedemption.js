const crypto = require("crypto");

// The audit row for one coupon redemption by one user — the "who used it, when,
// and what it granted" log. One row per (couponId, userId), unique-indexed as
// the authoritative second-redemption guard.

class CouponRedemption
{
    #id;
    #couponId;
    #codeString;
    #userId;
    #email;
    #benefitTarget;
    #benefitKind;
    #grantedSummary;
    #grantedCredits;
    #grantedPlanTier;
    #grantedDeckLicenseId;
    #discountAppliedMinor;
    #benefitExpiresAt;
    #redeemedAt;

    constructor(fields = {})
    {
        this.#id = (fields.id !== null && fields.id !== undefined && fields.id !== "") ? String(fields.id) : crypto.randomUUID();
        this.#couponId = String(fields.couponId ?? "");
        this.#codeString = String(fields.codeString ?? "");
        this.#userId = String(fields.userId ?? "");
        this.#email = String(fields.email ?? "").toLowerCase();
        this.#benefitTarget = fields.benefitTarget === null || fields.benefitTarget === undefined ? null : Number(fields.benefitTarget);
        this.#benefitKind = fields.benefitKind === null || fields.benefitKind === undefined ? null : Number(fields.benefitKind);
        this.#grantedSummary = String(fields.grantedSummary ?? "");
        this.#grantedCredits = fields.grantedCredits === null || fields.grantedCredits === undefined ? null : Number(fields.grantedCredits);
        this.#grantedPlanTier = fields.grantedPlanTier === null || fields.grantedPlanTier === undefined ? null : Number(fields.grantedPlanTier);
        this.#grantedDeckLicenseId = fields.grantedDeckLicenseId === null || fields.grantedDeckLicenseId === undefined || fields.grantedDeckLicenseId === "" ? null : String(fields.grantedDeckLicenseId);
        this.#discountAppliedMinor = fields.discountAppliedMinor === null || fields.discountAppliedMinor === undefined ? null : Number(fields.discountAppliedMinor);
        this.#benefitExpiresAt = fields.benefitExpiresAt === null || fields.benefitExpiresAt === undefined ? null : Number(fields.benefitExpiresAt);
        this.#redeemedAt = fields.redeemedAt instanceof Date ? fields.redeemedAt : (fields.redeemedAt ? new Date(fields.redeemedAt) : new Date());
    }

    getId() { return this.#id; }
    getCouponId() { return this.#couponId; }
    getCodeString() { return this.#codeString; }
    getUserId() { return this.#userId; }
    getEmail() { return this.#email; }
    getRedeemedAt() { return this.#redeemedAt; }
    getGrantedDeckLicenseId() { return this.#grantedDeckLicenseId; }

    toJson()
    {
        return {
            id: this.#id,
            couponId: this.#couponId,
            codeString: this.#codeString,
            userId: this.#userId,
            email: this.#email,
            benefitTarget: this.#benefitTarget,
            benefitKind: this.#benefitKind,
            grantedSummary: this.#grantedSummary,
            grantedCredits: this.#grantedCredits,
            grantedPlanTier: this.#grantedPlanTier,
            grantedDeckLicenseId: this.#grantedDeckLicenseId,
            discountAppliedMinor: this.#discountAppliedMinor,
            benefitExpiresAt: this.#benefitExpiresAt,
            redeemedAt: this.#redeemedAt
        };
    }

    static fromJson(json)
    {
        return new CouponRedemption(json || {});
    }
}

module.exports = CouponRedemption;
