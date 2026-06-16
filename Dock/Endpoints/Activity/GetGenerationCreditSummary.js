const CreditTransactionQueryEngine = require("../../Globals/Classes/Database/CreditTransactionQueryEngine");
const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");


/**
 * Human label for HOW a task type is billed, derived from its configured spend
 * rule's terms: per-token ("Tokens"), per-second ("Time"), per-MB ("Storage"),
 * a fixed charge ("Fixed"), or a combination. "Free" when no charging rule.
 */
function deriveBillingMethod(rule)
{
    if (!rule)
    {
        return "Free";
    }

    const dimensions = new Set();
    let bHasFlatTerm = false;
    for (const term of rule.getTerms())
    {
        const divisorKeys = Object.keys(term.getDivisors() || {});
        if (divisorKeys.length === 0)
        {
            bHasFlatTerm = true;
            continue;
        }
        for (const dimensionName of divisorKeys)
        {
            dimensions.add(dimensionName);
        }
    }

    const parts = [];
    if (dimensions.has("INPUT_TOKENS") || dimensions.has("OUTPUT_TOKENS"))
    {
        parts.push("Tokens");
    }
    if (dimensions.has("DURATION_SECONDS"))
    {
        parts.push("Time");
    }
    if (dimensions.has("STORAGE_MEGABYTES"))
    {
        parts.push("Storage");
    }
    if (bHasFlatTerm)
    {
        parts.push("Fixed");
    }
    return parts.length > 0 ? parts.join(" + ") : "Free";
}


/**
 * GET /Activity/Tasks/CreditSummary?taskid={mainTaskId}
 *
 * Returns the per-task credit-spend breakdown for one "Generate with AI" run,
 * aggregated from the creditTransactions ledger and scoped to the requesting
 * user. Shape:
 *
 *   {
 *     entries: [
 *       { taskType, credits, inputTokens, outputTokens, durationSeconds, chargeCount },
 *       ...
 *     ],
 *     totalCredits: number
 *   }
 *
 * Empty entries simply means nothing was charged for this run (e.g. an older
 * generation predating usage tracking, or a free configuration). The query is
 * filtered by userId, so a user can only ever read their own spend.
 */
async function getGenerationCreditSummary(request, response)
{
    const session = request.session;
    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const params = await request.getQueryParams();
    const taskId = params["taskid"];

    if (!taskId)
    {
        response.sendStatusCode(400);
        return;
    }

    const summary = await CreditTransactionQueryEngine.getGenerationSpendSummary(taskId, session.getUserId());

    // Annotate each row with HOW it was billed, read from the live config rule
    // for that task type, so the client can show a "Billed by" column.
    const configuration = await CreditConfigurationStore.load();
    if (configuration)
    {
        for (const entry of summary.entries)
        {
            entry.method = deriveBillingMethod(configuration.getRuleForTask(entry.taskType));
        }
    }

    response.sendJson(summary);
}

module.exports = { getGenerationCreditSummary };
