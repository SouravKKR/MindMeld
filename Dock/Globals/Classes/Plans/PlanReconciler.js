const AuthenticationQueryEngine = require('../Database/AuthenticationQueryEngine');
const DatabaseConnector = require('../Database/DatabaseConnector');
const DatabaseConstants = require('../../Constants/DatabaseConstants');
const PlanTierResolver = require('./PlanTierResolver');
const { planTiers } = require('../../Enumerations/PlanTiers');
const { subscriptionStatuses } = require('../../Enumerations/SubscriptionStatuses');

// Lazy, pull-based reconciliation of a user's plan state, run on GetUser (the
// same trigger the periodic-credit and streak reconcilers use). Its single job
// is to make the STORED plan field catch up with read-time expiry: when a paid
// plan's planExpiresAt has passed, persist plan → FREE and planStatus →
// EXPIRED. PlanTierResolver.getEffectiveTier already degrades an expired plan at
// read time, so enforcement is correct without this; persisting keeps the raw stored field
// (and therefore admin reports and any direct Mongo reader) truthful, with no
// scheduled job. Idempotent: it writes only when a downgrade is actually due.

class PlanReconciler
{
    /**
     * @param {string} userId
     * @returns {Promise<{changed: boolean, downgradedFrom?: number}>}
     */
    static async reconcile(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return { changed: false };
        }

        const user = await AuthenticationQueryEngine.getUserById(userId);
        if (!user)
        {
            return { changed: false };
        }

        const storedTier = PlanTierResolver.getStoredTier(user);
        const expiresAt = PlanTierResolver.getExpiresAt(user);
        const bIsLapsedPaidPlan = storedTier !== planTiers.FREE
            && expiresAt !== null
            && expiresAt < Date.now();

        if (!bIsLapsedPaidPlan)
        {
            return { changed: false };
        }

        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);

        await usersCollection.updateOne
        (
            { id: userId },
            { $set: { "additionalData.plan": planTiers.FREE, "additionalData.planStatus": subscriptionStatuses.EXPIRED } }
        );

        return { changed: true, downgradedFrom: storedTier };
    }
}

module.exports = PlanReconciler;
