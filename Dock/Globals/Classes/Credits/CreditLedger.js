const DatabaseConstants = require('../../Constants/DatabaseConstants');
const DatabaseConnector = require('../Database/DatabaseConnector');
const { creditTransactionTypes } = require('../../Enumerations/CreditTransactionTypes');
const CreditConfigurationStore = require('./CreditConfigurationStore');
const ErrorCodes = require('../../Constants/ErrorCodes');

// The atomic, idempotent charging engine. Every spend / grant is keyed by a
// stable `referenceKey` whose uniqueness in the creditTransactions collection
// guarantees a retried or replayed task can never double-charge. The
// authoritative balance lives in users.additionalData.credits and is mutated
// only through a guarded findOneAndUpdate so the minimumBalanceFloor is
// enforced atomically against concurrent charges.

class CreditLedger
{
    static #STATUS_PENDING = "pending";
    static #STATUS_APPLIED = "applied";
    static #STATUS_REJECTED = "rejected";
    static #DUPLICATE_KEY_ERROR_CODE = 11000;

    // Public mirror of the applied-status string so other engines (e.g. the
    // periodic-assignment report cross-check) can filter the ledger without
    // duplicating the literal.
    static TRANSACTION_STATUS_APPLIED = "applied";

    // additionalData keys owned exclusively by the credit subsystem. The
    // generic /UpdateUserAdditionalData merge MUST refuse these so a client
    // cannot set its own balance, spend history, or billing baseline.
    static LEDGER_OWNED_ADDITIONAL_DATA_KEYS = ["credits", "lifetimeCreditsSpent", "lastStorageAssessedAt"];

    static isLedgerOwnedAdditionalDataKey(fieldKey)
    {
        return CreditLedger.LEDGER_OWNED_ADDITIONAL_DATA_KEYS.includes(fieldKey);
    }

    static #round(value)
    {
        const numeric = parseFloat(value);
        if (isNaN(numeric))
        {
            return 0;
        }
        return Math.round(numeric * 10000) / 10000;
    }

    /**
     * Deducts credits for a chargeable subject. Returns a result describing
     * whether the charge applied, was already applied (idempotent replay),
     * or was rejected because it would breach the balance floor.
     *
     * @param {string} userId
     * @param {number} amountCredits — positive magnitude to deduct
     * @param {number} transactionType — CreditTransactionTypes value
     * @param {string} referenceKey — stable idempotency key
     * @param {object} metadata — audit context (taskId, metrics, etc.)
     * @param {number|null} minimumBalanceFloor — lowest post-balance allowed;
     *        null means unlimited (never blocked)
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, rejected: boolean, amount: number, balanceAfter?: number}>}
     */
    static async charge(userId, amountCredits, transactionType, referenceKey, metadata = {}, minimumBalanceFloor = null)
    {
        if (!userId || !referenceKey)
        {
            return { applied: false, alreadyApplied: false, rejected: false, amount: 0, reason: ErrorCodes.INVALID_REQUEST };
        }

        const roundedAmount = CreditLedger.#round(amountCredits);
        if (roundedAmount <= 0)
        {
            return { applied: true, alreadyApplied: false, rejected: false, amount: 0 };
        }

        const database = await DatabaseConnector.getDatabase();
        const transactionsCollection = database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

        const now = new Date();

        // Idempotency claim — a duplicate referenceKey means this exact
        // charge already ran; report its prior outcome and stop.
        try
        {
            await transactionsCollection.insertOne
            ({
                referenceKey: referenceKey,
                userId: userId,
                type: transactionType,
                amount: -roundedAmount,
                status: CreditLedger.#STATUS_PENDING,
                metadata: metadata || {},
                createdAt: now,
            });
        }
        catch (insertError)
        {
            if (insertError && insertError.code === CreditLedger.#DUPLICATE_KEY_ERROR_CODE)
            {
                const existing = await transactionsCollection.findOne({ referenceKey: referenceKey });
                return {
                    applied: existing?.status === CreditLedger.#STATUS_APPLIED,
                    alreadyApplied: true,
                    rejected: existing?.status === CreditLedger.#STATUS_REJECTED,
                    amount: existing ? Math.abs(existing.amount) : roundedAmount,
                };
            }
            throw insertError;
        }

        // Guarded decrement. When a floor is set, the filter refuses the
        // update unless the post-balance would stay at or above it.
        const filter = { id: userId };
        if (minimumBalanceFloor !== null && minimumBalanceFloor !== undefined)
        {
            filter["additionalData.credits"] = { $gte: roundedAmount + minimumBalanceFloor };
        }

        const updateResult = await usersCollection.findOneAndUpdate
        (
            filter,
            { $inc: { "additionalData.credits": -roundedAmount, "additionalData.lifetimeCreditsSpent": roundedAmount } },
            { returnDocument: "after" }
        );

        const updatedDocument = updateResult?.value || updateResult;

        if (!updatedDocument)
        {
            await transactionsCollection.updateOne
            (
                { referenceKey: referenceKey },
                { $set: { status: CreditLedger.#STATUS_REJECTED, resolvedAt: new Date() } }
            );
            return { applied: false, alreadyApplied: false, rejected: true, amount: roundedAmount };
        }

        const balanceAfter = updatedDocument.additionalData?.credits ?? null;
        const lifetimeSpent = updatedDocument.additionalData?.lifetimeCreditsSpent ?? 0;

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            { $set: { status: CreditLedger.#STATUS_APPLIED, balanceAfter: balanceAfter, resolvedAt: new Date() } }
        );

        await CreditLedger.#evaluateRewardMilestones(userId, lifetimeSpent);

        return { applied: true, alreadyApplied: false, rejected: false, amount: roundedAmount, balanceAfter: balanceAfter };
    }

    /**
     * Grants credits (signup bonus, reward, admin top-up). Idempotent on
     * referenceKey; never blocked by a floor.
     *
     * @param {string} userId
     * @param {number} amountCredits — positive magnitude to grant
     * @param {number} transactionType — CreditTransactionTypes value
     * @param {string} referenceKey — stable idempotency key
     * @param {object} metadata
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, amount: number, balanceAfter?: number}>}
     */
    static async grant(userId, amountCredits, transactionType, referenceKey, metadata = {})
    {
        if (!userId || !referenceKey)
        {
            return { applied: false, alreadyApplied: false, amount: 0, reason: ErrorCodes.INVALID_REQUEST };
        }

        const roundedAmount = CreditLedger.#round(amountCredits);
        if (roundedAmount <= 0)
        {
            return { applied: true, alreadyApplied: false, amount: 0 };
        }

        const database = await DatabaseConnector.getDatabase();
        const transactionsCollection = database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

        const now = new Date();

        try
        {
            await transactionsCollection.insertOne
            ({
                referenceKey: referenceKey,
                userId: userId,
                type: transactionType,
                amount: roundedAmount,
                status: CreditLedger.#STATUS_APPLIED,
                metadata: metadata || {},
                createdAt: now,
            });
        }
        catch (insertError)
        {
            if (insertError && insertError.code === CreditLedger.#DUPLICATE_KEY_ERROR_CODE)
            {
                return { applied: false, alreadyApplied: true, amount: roundedAmount };
            }
            throw insertError;
        }

        const updateResult = await usersCollection.findOneAndUpdate
        (
            { id: userId },
            { $inc: { "additionalData.credits": roundedAmount } },
            { returnDocument: "after" }
        );

        const updatedDocument = updateResult?.value || updateResult;
        const balanceAfter = updatedDocument?.additionalData?.credits ?? null;

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            { $set: { balanceAfter: balanceAfter, resolvedAt: new Date() } }
        );

        return { applied: true, alreadyApplied: false, amount: roundedAmount, balanceAfter: balanceAfter };
    }

    /**
     * Returns a user's current credit balance, or null if unknown.
     * @param {string} userId
     * @returns {Promise<number|null>}
     */
    static async getBalance(userId)
    {
        if (!userId)
        {
            return null;
        }
        const usersCollection = (await DatabaseConnector.getDatabase())
            .collection(DatabaseConstants.USERS_COLLECTION);
        const document = await usersCollection.findOne({ id: userId }, { projection: { "additionalData.credits": 1 } });
        const balance = document?.additionalData?.credits;
        return typeof balance === "number" ? balance : null;
    }

    static async #evaluateRewardMilestones(userId, lifetimeCreditsSpent)
    {
        const configuration = await CreditConfigurationStore.load();
        for (const milestone of configuration.getRewardMilestones())
        {
            if (lifetimeCreditsSpent >= milestone.getSpendThreshold() && milestone.getRewardCredits() > 0)
            {
                await CreditLedger.grant
                (
                    userId,
                    milestone.getRewardCredits(),
                    creditTransactionTypes.REWARD_GRANT,
                    `reward:${userId}:${milestone.getSpendThreshold()}`,
                    { spendThreshold: milestone.getSpendThreshold() }
                );
            }
        }
    }
}

module.exports = CreditLedger;
