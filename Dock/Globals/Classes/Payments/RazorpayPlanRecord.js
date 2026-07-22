const crypto = require("crypto");

// One row per (planTier, currency): the Razorpay Plan id created for that tier
// in that currency, cached so a plan is created at most once. Lives in the
// razorpayPlanRegistry collection with a unique (planTier, currency) index.

class RazorpayPlanRecord
{
    #id;
    #planTier;
    #currency;
    #providerPlanId;
    #amountMinor;
    #createdAt;

    constructor({ id = null, planTier = 0, currency = "", providerPlanId = "", amountMinor = 0, createdAt = new Date() } = {})
    {
        this.#id = id || crypto.randomUUID();
        this.#planTier = Number(planTier);
        this.#currency = String(currency || "").toUpperCase();
        this.#providerPlanId = String(providerPlanId || "");
        this.#amountMinor = Number(amountMinor) || 0;
        this.#createdAt = createdAt instanceof Date ? createdAt : new Date(createdAt);
    }

    getId()
    {
        return this.#id;
    }

    getPlanTier()
    {
        return this.#planTier;
    }

    getCurrency()
    {
        return this.#currency;
    }

    getProviderPlanId()
    {
        return this.#providerPlanId;
    }

    getAmountMinor()
    {
        return this.#amountMinor;
    }

    getCreatedAt()
    {
        return this.#createdAt;
    }

    toJson()
    {
        return {
            id: this.#id,
            planTier: this.#planTier,
            currency: this.#currency,
            providerPlanId: this.#providerPlanId,
            amountMinor: this.#amountMinor,
            createdAt: this.#createdAt
        };
    }

    static fromJson(json)
    {
        return new RazorpayPlanRecord
        ({
            id: json.id ?? null,
            planTier: json.planTier ?? 0,
            currency: json.currency ?? "",
            providerPlanId: json.providerPlanId ?? "",
            amountMinor: json.amountMinor ?? 0,
            createdAt: json.createdAt ?? new Date()
        });
    }
}

module.exports = RazorpayPlanRecord;
