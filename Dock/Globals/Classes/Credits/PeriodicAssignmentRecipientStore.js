const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * PeriodicAssignmentRecipientStore
 *
 * Owns the internal `periodicAssignmentRecipients` collection — one row per
 * (assignmentId, email). It is NOT a codegen model (like taskStates, it is a
 * lean server-internal document). The row serves two purposes:
 *
 *   1. A fast cursor for the reconciler — `onJoinGranted` and
 *      `lastGrantedPeriodKey` let it short-circuit work without scanning the
 *      ledger. This is an optimisation only; the unique referenceKey index on
 *      creditTransactions remains the TRUE idempotency guard, so a missing or
 *      stale recipient row can never cause a double grant.
 *   2. The report data source — cumulative credits, grant count, and first /
 *      last grant timestamps per beneficiary (current AND former members).
 *
 * Every write is an idempotent upsert keyed on (assignmentId, email) and is
 * only ever called AFTER CreditLedger.grant reports applied:true, so the
 * counters stay in lock-step with the authoritative ledger.
 */
class PeriodicAssignmentRecipientStore
{
    static #COLLECTION_NAME = DatabaseConstants.PERIODIC_ASSIGNMENT_RECIPIENTS_COLLECTION;

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(PeriodicAssignmentRecipientStore.#COLLECTION_NAME);
    }

    static #normaliseEmail(email)
    {
        if (typeof email !== "string")
        {
            return "";
        }
        return email.trim().toLowerCase();
    }

    /**
     * Records one applied grant against the (assignment, email) row. Bumps
     * the cumulative total and grant count, stamps the latest grant, and —
     * for the on-join installment — flips onJoinGranted permanently.
     *
     * @param {string} assignmentId
     * @param {string} rawEmail
     * @param {string} userId
     * @param {number} creditsDelta — positive credits just granted
     * @param {{ isOnJoin: boolean, periodKey: string|null, periodStartAt: Date|null }} grantKind
     * @param {Date} now
     */
    static async recordGrant(assignmentId, rawEmail, userId, creditsDelta, grantKind, now)
    {
        const collection = await PeriodicAssignmentRecipientStore.#getCollection();
        if (!collection)
        {
            return;
        }

        const email = PeriodicAssignmentRecipientStore.#normaliseEmail(rawEmail);
        if (assignmentId == null || email.length === 0)
        {
            return;
        }

        const stampedNow = now instanceof Date ? now : new Date();
        const safeDelta = typeof creditsDelta === "number" && isFinite(creditsDelta) ? creditsDelta : 0;
        const isOnJoin = grantKind && grantKind.isOnJoin === true;

        const setFields =
        {
            userId: typeof userId === "string" ? userId : "",
            lastGrantedAt: stampedNow
        };
        if (isOnJoin)
        {
            setFields.onJoinGranted = true;
            setFields.onJoinGrantedAt = stampedNow;
        }
        else if (grantKind && typeof grantKind.periodKey === "string")
        {
            setFields.lastGrantedPeriodKey = grantKind.periodKey;
            if (grantKind.periodStartAt instanceof Date)
            {
                setFields.lastGrantedPeriodStartAt = grantKind.periodStartAt;
            }
        }

        await collection.updateOne
        (
            { assignmentId: assignmentId, email: email },
            {
                $setOnInsert: { assignmentId: assignmentId, email: email, firstGrantedAt: stampedNow },
                $set: setFields,
                $inc: { cumulativeCredits: safeDelta, grantCount: 1 }
            },
            { upsert: true }
        );
    }

    /**
     * Advances the period cursor WITHOUT touching the cumulative counters.
     * Called when the ledger reports a period was already applied (a prior
     * run granted it but may have died before recordGrant) so the next
     * reconcile starts past it instead of re-enumerating the same period.
     * @param {string} assignmentId
     * @param {string} rawEmail
     * @param {string} periodKey
     * @param {Date} periodStartAt
     */
    static async advanceCursor(assignmentId, rawEmail, periodKey, periodStartAt)
    {
        const collection = await PeriodicAssignmentRecipientStore.#getCollection();
        if (!collection)
        {
            return;
        }
        const email = PeriodicAssignmentRecipientStore.#normaliseEmail(rawEmail);
        if (assignmentId == null || email.length === 0 || !(periodStartAt instanceof Date))
        {
            return;
        }

        // Only move the cursor forward — a stale/out-of-order call must never
        // rewind it (which would re-enumerate already-paid periods). No upsert:
        // if there is no recipient row yet the advance is simply skipped (the
        // next genuinely-applied grant creates the row via recordGrant).
        await collection.updateOne
        (
            {
                assignmentId: assignmentId,
                email: email,
                $or: [
                    { lastGrantedPeriodStartAt: { $exists: false } },
                    { lastGrantedPeriodStartAt: { $lt: periodStartAt } }
                ]
            },
            {
                $set: { lastGrantedPeriodKey: typeof periodKey === "string" ? periodKey : "", lastGrantedPeriodStartAt: periodStartAt }
            }
        );
    }

    /**
     * Permanently marks that the skip-first installment has been consumed for
     * this recipient, so a later reconcile never skips a legitimate period.
     * Upserts because the on-join grant that precedes it may have been an
     * idempotent replay that left no row.
     * @param {string} assignmentId
     * @param {string} rawEmail
     */
    static async markSkipFirstConsumed(assignmentId, rawEmail)
    {
        const collection = await PeriodicAssignmentRecipientStore.#getCollection();
        if (!collection)
        {
            return;
        }
        const email = PeriodicAssignmentRecipientStore.#normaliseEmail(rawEmail);
        if (assignmentId == null || email.length === 0)
        {
            return;
        }
        await collection.updateOne
        (
            { assignmentId: assignmentId, email: email },
            {
                $setOnInsert: { assignmentId: assignmentId, email: email },
                $set: { skipFirstConsumed: true }
            },
            { upsert: true }
        );
    }

    /**
     * Returns the raw recipient row (or null). The reconciler reads
     * `onJoinGranted` and `lastGrantedPeriodKey` from it as a cursor.
     * @param {string} assignmentId
     * @param {string} rawEmail
     * @returns {Promise<object|null>}
     */
    static async getRecipient(assignmentId, rawEmail)
    {
        const collection = await PeriodicAssignmentRecipientStore.#getCollection();
        if (!collection)
        {
            return null;
        }
        const email = PeriodicAssignmentRecipientStore.#normaliseEmail(rawEmail);
        if (assignmentId == null || email.length === 0)
        {
            return null;
        }
        return await collection.findOne({ assignmentId: assignmentId, email: email }, { projection: { _id: 0 } });
    }

    /**
     * Every beneficiary row for an assignment — current AND former members.
     * Drives the report's "all members who ever benefited" table.
     * @param {string} assignmentId
     * @returns {Promise<Array<object>>}
     */
    static async listByAssignment(assignmentId)
    {
        const collection = await PeriodicAssignmentRecipientStore.#getCollection();
        if (!collection || assignmentId == null)
        {
            return [];
        }
        return await collection
            .find({ assignmentId: assignmentId }, { projection: { _id: 0 } })
            .sort({ cumulativeCredits: -1 })
            .toArray();
    }
}

module.exports = PeriodicAssignmentRecipientStore;
