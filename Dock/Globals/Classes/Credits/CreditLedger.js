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

    // How many times a clawback re-derives the recoverable amount when a
    // concurrent spend beats it to the balance. Three is enough for any
    // realistic contention (a reversal is rare, and a spend racing one rarer
    // still) and bounded so a pathological write loop cannot spin. See
    // clawBack().
    static MAXIMUM_CLAWBACK_ATTEMPTS = 3;

    // additionalData keys owned exclusively by the credit subsystem. The
    // generic /UpdateUserAdditionalData merge MUST refuse these so a client
    // cannot set its own balance, spend history, or billing baseline.
    static LEDGER_OWNED_ADDITIONAL_DATA_KEYS = ["credits", "lifetimeCreditsSpent", "lastStorageAssessedAt", "plan", "planExpiresAt", "planStatus", "planSubscriptionId"];

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
     * Takes back credits a reversed payment had bought, down to a floor of zero.
     *
     * Deliberately NOT `charge` with a floor, even though that looks like the
     * same operation. `charge` is a SINGLE guarded attempt: it reads nothing,
     * refuses atomically if the balance cannot cover the amount, and marks its
     * claim row REJECTED. For a spend that is exactly right — the user simply
     * cannot afford it. For a clawback it is wrong twice over:
     *
     *   A caller must first READ the balance to know how much is recoverable,
     *   and a spend landing between that read and the write makes the guarded
     *   update match nothing. The clawback then recovers ZERO while reporting a
     *   shortfall computed from the stale read.
     *
     *   Retrying does not help, because the referenceKey has already been
     *   consumed by the rejected claim. A second call returns alreadyApplied
     *   with applied=false, so the credits are never recovered — not on this
     *   delivery of the refund webhook, and not on any later one either.
     *
     * So the recoverable amount is re-derived inside a bounded compare-and-set
     * loop, exactly as OrganizationCreditLedger.clawBack does for a pool. The
     * claim is inserted once for the full amount (a redelivered webhook is a
     * no-op) and resolved afterwards with what was ACTUALLY recovered.
     *
     * A partial recovery is deliberate: refusing because the user has since
     * spent the credits would leave the FULL amount in place rather than the
     * unrecoverable remainder. What could not be taken is returned as a
     * shortfall for a human to decide on, never as a negative balance the user
     * was never told about.
     *
     * @param {string} userId
     * @param {number} amountCredits positive magnitude the reversed payment bought
     * @param {string} referenceKey stable idempotency key
     * @param {object} metadata audit context
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, clawedBack: number, shortfall: number, balanceAfter: number|null}>}
     */
    static async clawBack(userId, amountCredits, referenceKey, metadata = {})
    {
        const roundedAmount = CreditLedger.#round(amountCredits);
        if (!userId || !referenceKey || roundedAmount <= 0)
        {
            return { applied: false, alreadyApplied: false, clawedBack: 0, shortfall: 0, balanceAfter: null };
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return { applied: false, alreadyApplied: false, clawedBack: 0, shortfall: 0, balanceAfter: null };
        }

        const transactionsCollection = database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

        try
        {
            await transactionsCollection.insertOne
            ({
                referenceKey: referenceKey,
                userId: userId,
                type: creditTransactionTypes.REFUND,
                amount: -roundedAmount,
                status: CreditLedger.#STATUS_PENDING,
                metadata: metadata || {},
                createdAt: new Date(),
            });
        }
        catch (insertError)
        {
            if (insertError && insertError.code === CreditLedger.#DUPLICATE_KEY_ERROR_CODE)
            {
                const existing = await transactionsCollection.findOne({ referenceKey: referenceKey });

                // `clawedBack` is what THIS call moved, which on a redelivery is
                // nothing. Reporting the original figure would read as a second
                // recovery to every caller, and the reversal alert would then
                // tell an operator the credits had been taken twice.
                return {
                    applied: existing?.status === CreditLedger.#STATUS_APPLIED,
                    alreadyApplied: true,
                    clawedBack: 0,
                    previouslyClawedBack: existing?.status === CreditLedger.#STATUS_APPLIED ? Math.abs(existing.amount) : 0,
                    shortfall: 0,
                    balanceAfter: existing?.balanceAfter ?? null
                };
            }
            throw insertError;
        }

        let clawedBack = 0;
        let balanceAfter = null;

        for (let attemptIndex = 0; attemptIndex < CreditLedger.MAXIMUM_CLAWBACK_ATTEMPTS; attemptIndex = attemptIndex + 1)
        {
            const currentUser = await usersCollection.findOne({ id: userId }, { projection: { "additionalData.credits": 1 } });
            const availableCredits = Math.max(CreditLedger.#round(currentUser?.additionalData?.credits) || 0, 0);
            const recoverableCredits = Math.min(roundedAmount, availableCredits);

            if (recoverableCredits <= 0)
            {
                balanceAfter = currentUser ? (currentUser.additionalData?.credits ?? null) : null;
                break;
            }

            const updateResult = await usersCollection.findOneAndUpdate
            (
                {
                    id: userId,
                    "additionalData.credits": { $gte: recoverableCredits }
                },
                {
                    // No lifetimeCreditsSpent increment: this is money coming
                    // back out, not credits the user spent on anything.
                    $inc: { "additionalData.credits": -recoverableCredits }
                },
                { returnDocument: "after" }
            );

            const updatedDocument = updateResult?.value || updateResult;
            if (updatedDocument)
            {
                clawedBack = recoverableCredits;
                balanceAfter = updatedDocument.additionalData?.credits ?? null;
                break;
            }
            // Lost the race to a concurrent spend — re-read and take whatever
            // is left.
        }

        const shortfall = CreditLedger.#round(roundedAmount - clawedBack);

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            {
                $set:
                {
                    status: clawedBack > 0 ? CreditLedger.#STATUS_APPLIED : CreditLedger.#STATUS_REJECTED,
                    amount: -clawedBack,
                    shortfall: shortfall,
                    balanceAfter: balanceAfter,
                    resolvedAt: new Date()
                }
            }
        );

        return { applied: clawedBack > 0, alreadyApplied: false, clawedBack: clawedBack, shortfall: shortfall, balanceAfter: balanceAfter };
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

        // Idempotency claim — insert PENDING first (mirroring charge). A duplicate
        // referenceKey means this exact grant already ran; report its prior
        // outcome and stop. Inserting as APPLIED up front would lie about a grant
        // that has not actually credited the user yet (see the null-user case).
        try
        {
            await transactionsCollection.insertOne
            ({
                referenceKey: referenceKey,
                userId: userId,
                type: transactionType,
                amount: roundedAmount,
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
                    amount: existing ? Math.abs(existing.amount) : roundedAmount,
                    balanceAfter: existing?.balanceAfter ?? null,
                };
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

        if (!updatedDocument)
        {
            // The target user does not exist, so no credits were applied. Mark the
            // claim rejected and report applied:false so the caller can compensate
            // (e.g. undo a promo redemption) instead of reporting a false success.
            await transactionsCollection.updateOne
            (
                { referenceKey: referenceKey },
                { $set: { status: CreditLedger.#STATUS_REJECTED, resolvedAt: new Date() } }
            );
            return { applied: false, alreadyApplied: false, rejected: true, amount: roundedAmount };
        }

        const balanceAfter = updatedDocument.additionalData?.credits ?? null;

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            { $set: { status: CreditLedger.#STATUS_APPLIED, balanceAfter: balanceAfter, resolvedAt: new Date() } }
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
