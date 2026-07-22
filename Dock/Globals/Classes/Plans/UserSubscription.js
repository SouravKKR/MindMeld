const crypto = require("crypto");
const { planTiers } = require("../../Enumerations/PlanTiers");
const { subscriptionStatuses } = require("../../Enumerations/SubscriptionStatuses");

// The server's record of a user's Razorpay subscription — the ledger of record
// for the plan. User.additionalData.plan is the fast-read mirror updated from
// here. One row per Razorpay subscription (unique providerSubscriptionId).

class UserSubscription
{
    #id;
    #userId;
    #email;
    #planTier;
    #currency;
    #providerSubscriptionId;
    #providerPlanId;
    #status;
    #currentPeriodStartAt;
    #currentPeriodEndAt;
    #appliedCouponId;
    #pendingDowngradeTier;
    #createdAt;
    #updatedAt;

    constructor(
    {
        id = null,
        userId = "",
        email = "",
        planTier = planTiers.FREE,
        currency = "",
        providerSubscriptionId = "",
        providerPlanId = "",
        status = subscriptionStatuses.CREATED,
        currentPeriodStartAt = null,
        currentPeriodEndAt = null,
        appliedCouponId = null,
        pendingDowngradeTier = null,
        createdAt = new Date(),
        updatedAt = new Date()
    } = {})
    {
        this.#id = id || crypto.randomUUID();
        this.#userId = String(userId || "");
        this.#email = String(email || "").toLowerCase();
        this.#planTier = Number(planTier);
        this.#currency = String(currency || "").toUpperCase();
        this.#providerSubscriptionId = String(providerSubscriptionId || "");
        this.#providerPlanId = String(providerPlanId || "");
        this.#status = Number(status);
        this.#currentPeriodStartAt = currentPeriodStartAt === null ? null : Number(currentPeriodStartAt);
        this.#currentPeriodEndAt = currentPeriodEndAt === null ? null : Number(currentPeriodEndAt);
        this.#appliedCouponId = appliedCouponId === null || appliedCouponId === undefined || appliedCouponId === "" ? null : String(appliedCouponId);
        this.#pendingDowngradeTier = pendingDowngradeTier === null || pendingDowngradeTier === undefined ? null : Number(pendingDowngradeTier);
        this.#createdAt = createdAt instanceof Date ? createdAt : new Date(createdAt);
        this.#updatedAt = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
    }

    getId() { return this.#id; }
    getUserId() { return this.#userId; }
    getEmail() { return this.#email; }
    getPlanTier() { return this.#planTier; }
    getCurrency() { return this.#currency; }
    getProviderSubscriptionId() { return this.#providerSubscriptionId; }
    getProviderPlanId() { return this.#providerPlanId; }
    getStatus() { return this.#status; }
    getCurrentPeriodStartAt() { return this.#currentPeriodStartAt; }
    getCurrentPeriodEndAt() { return this.#currentPeriodEndAt; }
    getAppliedCouponId() { return this.#appliedCouponId; }
    getPendingDowngradeTier() { return this.#pendingDowngradeTier; }
    getCreatedAt() { return this.#createdAt; }
    getUpdatedAt() { return this.#updatedAt; }

    setStatus(value) { this.#status = Number(value); }
    setCurrentPeriodStartAt(value) { this.#currentPeriodStartAt = value === null ? null : Number(value); }
    setCurrentPeriodEndAt(value) { this.#currentPeriodEndAt = value === null ? null : Number(value); }
    setPendingDowngradeTier(value) { this.#pendingDowngradeTier = value === null || value === undefined ? null : Number(value); }
    setUpdatedAt(value) { this.#updatedAt = value instanceof Date ? value : new Date(value); }

    toJson()
    {
        return {
            id: this.#id,
            userId: this.#userId,
            email: this.#email,
            planTier: this.#planTier,
            currency: this.#currency,
            providerSubscriptionId: this.#providerSubscriptionId,
            providerPlanId: this.#providerPlanId,
            status: this.#status,
            currentPeriodStartAt: this.#currentPeriodStartAt,
            currentPeriodEndAt: this.#currentPeriodEndAt,
            appliedCouponId: this.#appliedCouponId,
            pendingDowngradeTier: this.#pendingDowngradeTier,
            createdAt: this.#createdAt,
            updatedAt: this.#updatedAt
        };
    }

    static fromJson(json)
    {
        return new UserSubscription
        ({
            id: json.id ?? null,
            userId: json.userId ?? "",
            email: json.email ?? "",
            planTier: json.planTier ?? planTiers.FREE,
            currency: json.currency ?? "",
            providerSubscriptionId: json.providerSubscriptionId ?? "",
            providerPlanId: json.providerPlanId ?? "",
            status: json.status ?? subscriptionStatuses.CREATED,
            currentPeriodStartAt: json.currentPeriodStartAt ?? null,
            currentPeriodEndAt: json.currentPeriodEndAt ?? null,
            appliedCouponId: json.appliedCouponId ?? null,
            pendingDowngradeTier: json.pendingDowngradeTier ?? null,
            createdAt: json.createdAt ?? new Date(),
            updatedAt: json.updatedAt ?? new Date()
        });
    }
}

module.exports = UserSubscription;
