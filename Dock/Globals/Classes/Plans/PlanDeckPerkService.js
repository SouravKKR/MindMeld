const DatabaseConnector = require('../Database/DatabaseConnector');
const DatabaseConstants = require('../../Constants/DatabaseConstants');
const PlanMetadata = require('./PlanMetadata');

// The Pro Plus "one free marketplace deck of your choice each month" perk,
// modelled as a per-user monthly CLAIM rather than an auto-granted fixed deck
// (the user picks the deck). A claim row unique on (userId, periodKey) is the
// race guard: consuming the claim is an atomic insert, so two concurrent
// purchases in the same month cannot both go free. The claim is consumed at
// purchase time and released (compensated) if the subsequent grant fails.

class PlanDeckPerkService
{
    static #DUPLICATE_KEY_ERROR_CODE = 11000;
    static #indexEnsured = false;

    // UTC calendar-month key — one claim per user per month.
    static #periodKey(now)
    {
        const date = now instanceof Date ? now : new Date(now);
        const year = date.getUTCFullYear();
        // getUTCMonth() is 0-indexed; +1 so the stored key reads as the human
        // month (July → "2026-07"), keeping admin/report reads unambiguous.
        const month = date.getUTCMonth() + 1;
        return `${year}-${String(month).padStart(2, "0")}`;
    }

    static async #getCollection()
    {
        const collection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.PLAN_DECK_CLAIMS_COLLECTION);
        if (!PlanDeckPerkService.#indexEnsured)
        {
            await collection.createIndex({ userId: 1, periodKey: 1 }, { unique: true });
            PlanDeckPerkService.#indexEnsured = true;
        }
        return collection;
    }

    /**
     * How many free-deck claims the tier grants per month (0 unless the tier
     * carries the perk, i.e. Pro Plus).
     * @param {number} tier — planTiers value
     * @returns {number}
     */
    static getMonthlyClaimAllowance(tier)
    {
        return PlanMetadata.getMonthlyFreeDeckCount(tier);
    }

    /**
     * Whether the user (given their effective tier) still has an unused claim
     * this month. For display only — consumption must go through
     * tryConsumeClaim, which is the atomic gate.
     * @param {string} userId
     * @param {number} tier — planTiers value
     * @param {Date} [now]
     * @returns {Promise<boolean>}
     */
    static async hasClaimAvailable(userId, tier, now = new Date())
    {
        if (PlanDeckPerkService.getMonthlyClaimAllowance(tier) <= 0)
        {
            return false;
        }
        const collection = await PlanDeckPerkService.#getCollection();
        const existing = await collection.findOne({ userId: userId, periodKey: PlanDeckPerkService.#periodKey(now) });
        return !existing;
    }

    /**
     * Atomically consume this month's claim for a deck. The unique
     * (userId, periodKey) index guarantees exactly one success per user per
     * month even under concurrent purchases.
     * @param {string} userId
     * @param {number} tier — planTiers value
     * @param {string} deckId
     * @param {Date} [now]
     * @returns {Promise<{consumed: boolean, periodKey: string|null}>}
     */
    static async tryConsumeClaim(userId, tier, deckId, now = new Date())
    {
        if (PlanDeckPerkService.getMonthlyClaimAllowance(tier) <= 0)
        {
            return { consumed: false, periodKey: null };
        }

        const periodKey = PlanDeckPerkService.#periodKey(now);
        const collection = await PlanDeckPerkService.#getCollection();

        try
        {
            await collection.insertOne
            ({
                userId: userId,
                periodKey: periodKey,
                deckId: deckId,
                planTier: Number(tier),
                claimedAt: now instanceof Date ? now : new Date(now)
            });
            return { consumed: true, periodKey: periodKey };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === PlanDeckPerkService.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { consumed: false, periodKey: periodKey };
            }
            throw insertError;
        }
    }

    /**
     * Releases a consumed claim — compensation for when the grant that follows
     * a successful consume fails, so the user does not lose the month's perk.
     * @param {string} userId
     * @param {string} periodKey
     */
    static async releaseClaim(userId, periodKey)
    {
        if (!userId || !periodKey)
        {
            return;
        }
        const collection = await PlanDeckPerkService.#getCollection();
        await collection.deleteOne({ userId: userId, periodKey: periodKey });
    }
}

module.exports = PlanDeckPerkService;
