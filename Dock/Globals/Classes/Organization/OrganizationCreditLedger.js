const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const OrganizationCreditPool = require("../../Model/OrganizationCreditPool");
const ErrorCodes = require("../../Constants/ErrorCodes");


/**
 * OrganizationCreditLedger
 *
 * The credits an organization has bought and not yet handed out, and every
 * movement in or out of that balance.
 *
 * It is a close mirror of CreditLedger, and for the same reasons: a claim row
 * is inserted PENDING first so a unique `referenceKey` makes a replayed
 * payment or a retried distribution a no-op rather than a double credit, and
 * the balance is moved with a single guarded findOneAndUpdate whose FILTER
 * carries the floor — so two distributions racing each other can never take the
 * pool below zero between a read and a write.
 *
 * It is deliberately separate from CreditLedger rather than a mode of it. The
 * two balances answer to different owners: a user's balance is theirs and is
 * spent by using the product, while a pool is the institute's and is spent by
 * giving it away. Sharing one table would make "how much has this organization
 * distributed" a query over rows that also contain private spending.
 */
class OrganizationCreditLedger
{
    static #STATUS_PENDING = "pending";
    static #STATUS_APPLIED = "applied";
    static #STATUS_REJECTED = "rejected";
    static #DUPLICATE_KEY_ERROR_CODE = 11000;

    static TRANSACTION_STATUS_APPLIED = "applied";

    // Who moved the credits, recorded in a movement's metadata. Named here
    // because the ledger is what stores it and two other classes read it back:
    // a literal repeated across files is a rename waiting to break one of them
    // silently.
    static MOVEMENT_SOURCE_ADMIN_GRANT = "ADMIN_GRANT";

    static TRANSACTION_TYPE_PURCHASE = "PURCHASE";
    static TRANSACTION_TYPE_DISTRIBUTION = "DISTRIBUTION";
    static TRANSACTION_TYPE_ADJUSTMENT = "ADJUSTMENT";

    // How many times a clawback re-derives the recoverable amount when a
    // concurrent spend beats it to the pool. Three is enough for any realistic
    // contention (a reversal is rare, and a distribution racing one rarer
    // still) and bounded so a pathological write loop cannot spin.
    static MAXIMUM_CLAWBACK_ATTEMPTS = 3;

    static #round(value)
    {
        const numeric = parseFloat(value);
        if (isNaN(numeric))
        {
            return 0;
        }
        return Math.round(numeric * 10000) / 10000;
    }

    static async #getPoolsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database ? database.collection(DatabaseConstants.ORGANIZATION_CREDIT_POOLS_COLLECTION) : null;
    }

    static async #getTransactionsCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database ? database.collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION) : null;
    }

    /**
     * The organization's pool, created empty on first read so every caller can
     * treat it as always present. An organization that has never bought credits
     * has a pool of zero rather than no pool — "no pool" would otherwise have to
     * be handled separately everywhere it is read.
     *
     * @param {string} organizationId
     * @returns {Promise<OrganizationCreditPool|null>}
     */
    static async getPool(organizationId)
    {
        const collection = await OrganizationCreditLedger.#getPoolsCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return null;
        }

        const existingDocument = await collection.findOne({ organizationId: organizationId }, { projection: { _id: 0 } });
        if (existingDocument)
        {
            return OrganizationCreditPool.fromJson(existingDocument);
        }

        const freshPool = new OrganizationCreditPool
        ({
            organizationId: organizationId,
            balance: 0,
            lifetimeGranted: 0,
            lifetimeDistributed: 0,
            frozen: false,
            updatedAt: new Date()
        });

        // upsert rather than insert: two first reads can race, and the loser
        // must find the winner's pool rather than fail.
        await collection.updateOne
        (
            { organizationId: organizationId },
            { $setOnInsert: freshPool.toJson() },
            { upsert: true }
        );

        const storedDocument = await collection.findOne({ organizationId: organizationId }, { projection: { _id: 0 } });
        return storedDocument ? OrganizationCreditPool.fromJson(storedDocument) : freshPool;
    }

    /**
     * Adds credits to a pool — a settled purchase, or a super-admin adjustment.
     * Idempotent on `referenceKey`, so a replayed payment webhook credits once.
     *
     * @param {string} organizationId
     * @param {number} amountCredits positive magnitude
     * @param {string} transactionType one of the TRANSACTION_TYPE_* constants
     * @param {string} referenceKey stable idempotency key
     * @param {object} metadata audit context
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, amount: number, balanceAfter: number|null}>}
     */
    static async credit(organizationId, amountCredits, transactionType, referenceKey, metadata = {})
    {
        const roundedAmount = OrganizationCreditLedger.#round(amountCredits);
        if (!organizationId || !referenceKey || roundedAmount <= 0)
        {
            return { applied: false, alreadyApplied: false, amount: 0, balanceAfter: null, reason: ErrorCodes.INVALID_REQUEST };
        }

        await OrganizationCreditLedger.getPool(organizationId);

        const transactionsCollection = await OrganizationCreditLedger.#getTransactionsCollection();
        const poolsCollection = await OrganizationCreditLedger.#getPoolsCollection();

        const claim = await OrganizationCreditLedger.#claim(transactionsCollection, referenceKey, organizationId, transactionType, roundedAmount, metadata);
        if (claim.alreadyApplied)
        {
            return claim.result;
        }

        const updateResult = await poolsCollection.findOneAndUpdate
        (
            { organizationId: organizationId },
            {
                $inc: { balance: roundedAmount, lifetimeGranted: roundedAmount },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: "after" }
        );

        const updatedDocument = updateResult?.value || updateResult;
        if (!updatedDocument)
        {
            await transactionsCollection.updateOne({ referenceKey: referenceKey }, { $set: { status: OrganizationCreditLedger.#STATUS_REJECTED, resolvedAt: new Date() } });
            return { applied: false, alreadyApplied: false, rejected: true, amount: roundedAmount, balanceAfter: null };
        }

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            { $set: { status: OrganizationCreditLedger.#STATUS_APPLIED, balanceAfter: updatedDocument.balance, resolvedAt: new Date() } }
        );

        return { applied: true, alreadyApplied: false, amount: roundedAmount, balanceAfter: updatedDocument.balance };
    }

    /**
     * Takes credits out of a pool to hand to members. Refused — atomically —
     * when the pool cannot cover it or is frozen, because the alternative is a
     * distribution that credits half a roster and then stops.
     *
     * The balance floor and the frozen flag both live in the update FILTER, not
     * in a preceding read: a check-then-write would let two distributions
     * launched seconds apart each see enough balance and both proceed.
     *
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, amount: number, balanceAfter: number|null, reason?: string}>}
     */
    static async debit(organizationId, amountCredits, transactionType, referenceKey, metadata = {})
    {
        const roundedAmount = OrganizationCreditLedger.#round(amountCredits);
        if (!organizationId || !referenceKey || roundedAmount <= 0)
        {
            return { applied: false, alreadyApplied: false, amount: 0, balanceAfter: null, reason: ErrorCodes.INVALID_REQUEST };
        }

        await OrganizationCreditLedger.getPool(organizationId);

        const transactionsCollection = await OrganizationCreditLedger.#getTransactionsCollection();
        const poolsCollection = await OrganizationCreditLedger.#getPoolsCollection();

        const claim = await OrganizationCreditLedger.#claim(transactionsCollection, referenceKey, organizationId, transactionType, -roundedAmount, metadata);
        if (claim.alreadyApplied)
        {
            return claim.result;
        }

        const updateResult = await poolsCollection.findOneAndUpdate
        (
            {
                organizationId: organizationId,
                frozen: { $ne: true },
                balance: { $gte: roundedAmount }
            },
            {
                $inc: { balance: -roundedAmount, lifetimeDistributed: roundedAmount },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: "after" }
        );

        const updatedDocument = updateResult?.value || updateResult;

        if (!updatedDocument)
        {
            // Distinguish the two refusals, because they need different actions:
            // a frozen pool needs a renewal, an empty one needs a top-up.
            const currentPool = await poolsCollection.findOne({ organizationId: organizationId });
            const refusalReason = currentPool?.frozen === true ? ErrorCodes.ORG_POOL_FROZEN : ErrorCodes.ORG_POOL_INSUFFICIENT;

            await transactionsCollection.updateOne
            (
                { referenceKey: referenceKey },
                { $set: { status: OrganizationCreditLedger.#STATUS_REJECTED, rejectionReason: refusalReason, resolvedAt: new Date() } }
            );

            return {
                applied: false,
                alreadyApplied: false,
                rejected: true,
                amount: roundedAmount,
                balanceAfter: currentPool ? currentPool.balance : null,
                reason: refusalReason
            };
        }

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            { $set: { status: OrganizationCreditLedger.#STATUS_APPLIED, balanceAfter: updatedDocument.balance, resolvedAt: new Date() } }
        );

        return { applied: true, alreadyApplied: false, amount: roundedAmount, balanceAfter: updatedDocument.balance };
    }

    /**
     * Takes back credits a reversed payment had bought, down to a floor of zero.
     *
     * Deliberately NOT `debit`, because a clawback answers to different rules
     * than a distribution:
     *
     *   A frozen pool is still clawed back. `debit` refuses one, which is right
     *   for a distribution — a lapsed contract must not hand credits out — and
     *   wrong here, where the money has gone back to the payer and a freeze
     *   would simply mean the institute keeps credits it no longer paid for.
     *
     *   A partial recovery is better than none. `debit` is all-or-nothing so a
     *   distribution never credits half a roster; a clawback that refuses
     *   because the pool has since been spent down would leave the FULL amount
     *   in place rather than the unrecoverable remainder.
     *
     *   The pool is never taken below zero. A negative balance would block an
     *   institute from operating over a debt it was never told about, so what
     *   cannot be recovered is reported as a shortfall for a human to decide on
     *   instead of being forced through silently.
     *
     * The recoverable amount is re-derived inside a bounded compare-and-set
     * loop rather than read once and trusted: a distribution landing between the
     * read and the write would otherwise make the update match nothing and
     * silently recover zero.
     *
     * @returns {Promise<{applied: boolean, alreadyApplied: boolean, clawedBack: number, shortfall: number, balanceAfter: number|null}>}
     */
    static async clawBack(organizationId, amountCredits, referenceKey, metadata = {})
    {
        const roundedAmount = OrganizationCreditLedger.#round(amountCredits);
        if (!organizationId || !referenceKey || roundedAmount <= 0)
        {
            return { applied: false, alreadyApplied: false, clawedBack: 0, shortfall: 0, balanceAfter: null };
        }

        await OrganizationCreditLedger.getPool(organizationId);

        const transactionsCollection = await OrganizationCreditLedger.#getTransactionsCollection();
        const poolsCollection = await OrganizationCreditLedger.#getPoolsCollection();

        // Claimed for the full amount first, so a redelivered refund webhook is
        // a no-op even if this process dies mid-loop. The row is resolved with
        // what was ACTUALLY recovered once the loop finishes.
        const claim = await OrganizationCreditLedger.#claim(transactionsCollection, referenceKey, organizationId, OrganizationCreditLedger.TRANSACTION_TYPE_ADJUSTMENT, -roundedAmount, metadata);
        if (claim.alreadyApplied)
        {
            // `clawedBack` is what THIS call moved, which on a redelivery is
            // nothing. Reporting the original call's figure here would read as a
            // second recovery to every caller — and the reversal alert would
            // then tell an operator the credits had been taken twice.
            return {
                applied: claim.result.applied === true,
                alreadyApplied: true,
                clawedBack: 0,
                previouslyClawedBack: claim.result.applied === true ? claim.result.amount : 0,
                shortfall: 0,
                balanceAfter: claim.result.balanceAfter
            };
        }

        let clawedBack = 0;
        let balanceAfter = null;

        for (let attemptIndex = 0; attemptIndex < OrganizationCreditLedger.MAXIMUM_CLAWBACK_ATTEMPTS; attemptIndex = attemptIndex + 1)
        {
            const currentPool = await poolsCollection.findOne({ organizationId: organizationId });
            const availableCredits = Math.max(OrganizationCreditLedger.#round(currentPool?.balance) || 0, 0);
            const recoverableCredits = Math.min(roundedAmount, availableCredits);

            if (recoverableCredits <= 0)
            {
                balanceAfter = currentPool ? currentPool.balance : null;
                break;
            }

            const updateResult = await poolsCollection.findOneAndUpdate
            (
                {
                    organizationId: organizationId,
                    // No frozen check, and no lifetimeDistributed increment: this
                    // is money coming back out of the pool, not credits handed to
                    // anyone.
                    balance: { $gte: recoverableCredits }
                },
                {
                    $inc: { balance: -recoverableCredits },
                    $set: { updatedAt: new Date() }
                },
                { returnDocument: "after" }
            );

            const updatedDocument = updateResult?.value || updateResult;
            if (updatedDocument)
            {
                clawedBack = recoverableCredits;
                balanceAfter = updatedDocument.balance;
                break;
            }
            // Lost the race to a concurrent spend — re-read and try for whatever
            // is left.
        }

        const shortfall = OrganizationCreditLedger.#round(roundedAmount - clawedBack);

        await transactionsCollection.updateOne
        (
            { referenceKey: referenceKey },
            {
                $set:
                {
                    status: clawedBack > 0 ? OrganizationCreditLedger.#STATUS_APPLIED : OrganizationCreditLedger.#STATUS_REJECTED,
                    amount: -clawedBack,
                    shortfall: shortfall,
                    rejectionReason: clawedBack > 0 ? "" : ErrorCodes.ORG_POOL_INSUFFICIENT,
                    balanceAfter: balanceAfter,
                    resolvedAt: new Date()
                }
            }
        );

        return { applied: clawedBack > 0, alreadyApplied: false, clawedBack: clawedBack, shortfall: shortfall, balanceAfter: balanceAfter };
    }

    /**
     * Refunds credits to the pool for a distribution that could not be handed
     * out after all — a recipient whose account had vanished, say. Recorded as
     * its own movement rather than by reversing the original, so the trail
     * shows what actually happened.
     */
    static async refund(organizationId, amountCredits, referenceKey, metadata = {})
    {
        return await OrganizationCreditLedger.credit(organizationId, amountCredits, OrganizationCreditLedger.TRANSACTION_TYPE_ADJUSTMENT, referenceKey, metadata);
    }

    /**
     * Freezes or unfreezes a pool. A frozen pool refuses every debit, which is
     * how a lapsed contract stops distributions without touching the credits
     * already bought — they wait for the renewal rather than being lost.
     */
    static async setFrozen(organizationId, bFrozen)
    {
        const collection = await OrganizationCreditLedger.#getPoolsCollection();
        if (!collection)
        {
            return { updated: false };
        }

        await OrganizationCreditLedger.getPool(organizationId);
        const updateResult = await collection.updateOne
        (
            { organizationId: organizationId },
            { $set: { frozen: bFrozen === true, updatedAt: new Date() } }
        );

        return { updated: updateResult.matchedCount === 1 };
    }

    /**
     * The transaction type of a stored movement.
     *
     * The claim row names the field `type`, which is NOT what the model-shaped
     * `transactionType` parameter elsewhere in this class is called. Reading it
     * through here rather than by hand means a caller cannot quietly read
     * `undefined` and conclude the movement was an adjustment — which is
     * exactly what happened before this existed.
     *
     * @param {object} transactionDocument
     * @returns {string}
     */
    static readTransactionType(transactionDocument)
    {
        return transactionDocument && typeof transactionDocument.type === "string" ? transactionDocument.type : "";
    }

    /**
     * The pool's movements, newest first, for the organization's own ledger view.
     */
    static async listTransactions(organizationId, limit = 100)
    {
        const collection = await OrganizationCreditLedger.#getTransactionsCollection();
        if (!collection)
        {
            return [];
        }

        return await collection
            .find({ organizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(500, limit)))
            .toArray();
    }

    /**
     * Inserts the idempotency claim. A duplicate key means this exact movement
     * already ran, so its previous outcome is reported instead of repeating it.
     */
    static async #claim(transactionsCollection, referenceKey, organizationId, transactionType, signedAmount, metadata)
    {
        try
        {
            await transactionsCollection.insertOne
            ({
                referenceKey: referenceKey,
                organizationId: organizationId,
                type: transactionType,
                amount: signedAmount,
                status: OrganizationCreditLedger.#STATUS_PENDING,
                metadata: metadata || {},
                createdAt: new Date()
            });
            return { alreadyApplied: false };
        }
        catch (insertError)
        {
            if (insertError && insertError.code === OrganizationCreditLedger.#DUPLICATE_KEY_ERROR_CODE)
            {
                const existing = await transactionsCollection.findOne({ referenceKey: referenceKey });
                return {
                    alreadyApplied: true,
                    result:
                    {
                        applied: existing?.status === OrganizationCreditLedger.#STATUS_APPLIED,
                        alreadyApplied: true,
                        amount: existing ? Math.abs(existing.amount) : Math.abs(signedAmount),
                        balanceAfter: existing?.balanceAfter ?? null,
                        reason: existing?.rejectionReason
                    }
                };
            }
            throw insertError;
        }
    }
}

module.exports = OrganizationCreditLedger;
