const DatabaseConnector = require("./DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");


/**
 * CreditTransactionQueryEngine
 *
 * Read-side helpers over the creditTransactions ledger. Each per-task charge
 * the Agent applies is one transaction row carrying:
 *   { userId, amount (negative for a charge), status, metadata: {
 *       taskId, taskType, mainTaskId, phase, usage: { inputTokens,
 *       outputTokens, durationSeconds } } }
 *
 * mainTaskId ties every child charge back to the generation it belongs to,
 * which lets the Activity page render a per-task credit-spend breakdown for a
 * whole "Generate with AI" run.
 *
 * Collection: [DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION].
 */
class CreditTransactionQueryEngine
{
    static #COLLECTION_NAME = DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION;

    // Mirrors CreditLedger's applied-status marker (Dock + Agent both write it).
    static #STATUS_APPLIED = "applied";

    static async #getCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            return null;
        }
        return database.collection(CreditTransactionQueryEngine.#COLLECTION_NAME);
    }

    /**
     * Aggregates every applied charge that belongs to one generation
     * (matched by metadata.mainTaskId) into a per-task-type spend summary.
     * Scoped to the owning user, so a caller can only ever read their own
     * spend. Returns rows sorted by credits spent, descending.
     *
     * @param {string} mainTaskId
     * @param {string} userId
     * @returns {Promise<{ entries: Array<object>, totalCredits: number }>}
     */
    static async getGenerationSpendSummary(mainTaskId, userId)
    {
        if (!mainTaskId || !userId)
        {
            return { entries: [], totalCredits: 0 };
        }

        const collection = await CreditTransactionQueryEngine.#getCollection();
        if (!collection)
        {
            return { entries: [], totalCredits: 0 };
        }

        const pipeline =
        [
            {
                $match:
                {
                    userId: userId,
                    "metadata.mainTaskId": mainTaskId,
                    status: CreditTransactionQueryEngine.#STATUS_APPLIED,
                    amount: { $lt: 0 }
                }
            },
            {
                $group:
                {
                    _id: "$metadata.taskType",
                    credits: { $sum: { $abs: "$amount" } },
                    inputTokens: { $sum: { $ifNull: ["$metadata.usage.inputTokens", 0] } },
                    outputTokens: { $sum: { $ifNull: ["$metadata.usage.outputTokens", 0] } },
                    durationSeconds: { $sum: { $ifNull: ["$metadata.usage.durationSeconds", 0] } },
                    chargeCount: { $sum: 1 }
                }
            },
            { $sort: { credits: -1 } }
        ];

        const rows = await collection.aggregate(pipeline).toArray();

        let totalCredits = 0;
        const entries = rows.map((row) =>
        {
            const credits = Math.round((row.credits || 0) * 10000) / 10000;
            totalCredits += credits;
            return {
                taskType: row._id,
                credits: credits,
                inputTokens: row.inputTokens || 0,
                outputTokens: row.outputTokens || 0,
                durationSeconds: Math.round((row.durationSeconds || 0) * 100) / 100,
                chargeCount: row.chargeCount || 0
            };
        });

        return { entries: entries, totalCredits: Math.round(totalCredits * 10000) / 10000 };
    }
}

module.exports = CreditTransactionQueryEngine;
