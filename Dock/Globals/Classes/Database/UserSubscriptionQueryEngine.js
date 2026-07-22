const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const UserSubscription = require("../Plans/UserSubscription");
const { subscriptionStatuses } = require("../../Enumerations/SubscriptionStatuses");

// Persistence for UserSubscription rows in the userSubscriptions collection.
// Unique providerSubscriptionId (the webhook and verify both key on it); an
// index on userId for "the user's current subscription" reads.

class UserSubscriptionQueryEngine
{
    static #indexEnsured = false;

    static async #getCollection()
    {
        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USER_SUBSCRIPTIONS_COLLECTION);
        if (!UserSubscriptionQueryEngine.#indexEnsured)
        {
            await collection.createIndex({ providerSubscriptionId: 1 }, { unique: true });
            await collection.createIndex({ userId: 1, createdAt: -1 });
            UserSubscriptionQueryEngine.#indexEnsured = true;
        }
        return collection;
    }

    /**
     * @param {UserSubscription} subscription
     * @returns {Promise<UserSubscription>}
     */
    static async create(subscription)
    {
        const collection = await UserSubscriptionQueryEngine.#getCollection();
        await collection.insertOne(subscription.toJson());
        return subscription;
    }

    static async getByProviderSubscriptionId(providerSubscriptionId)
    {
        if (!providerSubscriptionId)
        {
            return null;
        }
        const collection = await UserSubscriptionQueryEngine.#getCollection();
        const json = await collection.findOne({ providerSubscriptionId: providerSubscriptionId });
        return json ? UserSubscription.fromJson(json) : null;
    }

    /**
     * The user's most recent NON-TERMINAL subscription — the one Cancel/Change
     * should act on. Excludes CREATED (an abandoned, never-authorized Initiate
     * row) and the terminal states (CANCELLED/COMPLETED/EXPIRED), so a stale row
     * can never shadow the genuinely-active subscription. Returns null when the
     * user has no live subscription.
     * @param {string} userId
     * @returns {Promise<UserSubscription|null>}
     */
    static async getActiveByUserId(userId)
    {
        if (!userId)
        {
            return null;
        }
        const collection = await UserSubscriptionQueryEngine.#getCollection();
        const json = await collection
            .find({
                userId: userId,
                status: { $in: [subscriptionStatuses.AUTHENTICATED, subscriptionStatuses.ACTIVE, subscriptionStatuses.PENDING, subscriptionStatuses.HALTED] }
            })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray();
        return json.length > 0 ? UserSubscription.fromJson(json[0]) : null;
    }

    /**
     * The user's most recent subscription row (any status), or null.
     * @param {string} userId
     * @returns {Promise<UserSubscription|null>}
     */
    static async getLatestByUserId(userId)
    {
        if (!userId)
        {
            return null;
        }
        const collection = await UserSubscriptionQueryEngine.#getCollection();
        const json = await collection
            .find({ userId: userId })
            .sort({ createdAt: -1 })
            .limit(1)
            .toArray();
        return json.length > 0 ? UserSubscription.fromJson(json[0]) : null;
    }

    /**
     * Atomically patches status + period on the row keyed by
     * providerSubscriptionId. Only the provided fields are written.
     * @param {string} providerSubscriptionId
     * @param {{status?: number, currentPeriodStartAt?: number|null, currentPeriodEndAt?: number|null, pendingDowngradeTier?: number|null, appliedCouponId?: string|null}} patch
     */
    static async patchByProviderSubscriptionId(providerSubscriptionId, patch)
    {
        if (!providerSubscriptionId)
        {
            return;
        }
        const setFields = { updatedAt: new Date() };
        if (patch.status !== undefined) { setFields.status = Number(patch.status); }
        if (patch.currentPeriodStartAt !== undefined) { setFields.currentPeriodStartAt = patch.currentPeriodStartAt === null ? null : Number(patch.currentPeriodStartAt); }
        if (patch.currentPeriodEndAt !== undefined) { setFields.currentPeriodEndAt = patch.currentPeriodEndAt === null ? null : Number(patch.currentPeriodEndAt); }
        if (patch.pendingDowngradeTier !== undefined) { setFields.pendingDowngradeTier = patch.pendingDowngradeTier === null ? null : Number(patch.pendingDowngradeTier); }
        if (patch.appliedCouponId !== undefined) { setFields.appliedCouponId = patch.appliedCouponId; }

        const collection = await UserSubscriptionQueryEngine.#getCollection();
        await collection.updateOne({ providerSubscriptionId: providerSubscriptionId }, { $set: setFields });
    }
}

module.exports = UserSubscriptionQueryEngine;
