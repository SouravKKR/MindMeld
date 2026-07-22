const { planTiers } = require("../../Enumerations/PlanTiers");

// Interprets a user's plan state from additionalData. Lives here (not on the
// User model) because User is codegen-derived from Common/Classes/User.json —
// the generator emits only field getters/setters, so read-time-expiry logic
// cannot live on the model without being wiped by the next `npm run setup`.
// The four plan keys are ledger-owned, so only the server writes them.

class PlanTierResolver
{
    static #additionalData(user)
    {
        return (user && typeof user.getAdditionalData === "function") ? (user.getAdditionalData() || {}) : {};
    }

    /**
     * The tier stored on the account, before any expiry check. FREE when absent
     * or malformed.
     * @param {User} user
     * @returns {number} planTiers value
     */
    static getStoredTier(user)
    {
        const numericTier = Number(PlanTierResolver.#additionalData(user).plan);
        return Object.values(planTiers).includes(numericTier) ? numericTier : planTiers.FREE;
    }

    /**
     * The effective tier right now — a paid tier whose planExpiresAt has passed
     * degrades to FREE at read time.
     * @param {User} user
     * @returns {number} planTiers value
     */
    static getEffectiveTier(user)
    {
        const storedTier = PlanTierResolver.getStoredTier(user);
        if (storedTier === planTiers.FREE)
        {
            return planTiers.FREE;
        }
        const expiresAt = PlanTierResolver.getExpiresAt(user);
        if (expiresAt !== null && expiresAt < Date.now())
        {
            return planTiers.FREE;
        }
        return storedTier;
    }

    /**
     * Epoch milliseconds when the current plan lapses, or null.
     * @param {User} user
     * @returns {number|null}
     */
    static getExpiresAt(user)
    {
        const raw = PlanTierResolver.#additionalData(user).planExpiresAt;
        if (raw === null || raw === undefined)
        {
            return null;
        }
        const numeric = Number(raw);
        return isNaN(numeric) ? null : numeric;
    }

    static getStatus(user)
    {
        const raw = PlanTierResolver.#additionalData(user).planStatus;
        if (raw === null || raw === undefined)
        {
            return null;
        }
        const numeric = Number(raw);
        return isNaN(numeric) ? null : numeric;
    }

    static getSubscriptionId(user)
    {
        const raw = PlanTierResolver.#additionalData(user).planSubscriptionId;
        return (raw === null || raw === undefined || raw === "") ? null : String(raw);
    }
}

module.exports = PlanTierResolver;
