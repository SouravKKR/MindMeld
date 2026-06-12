const { creditDeductionTimings } = require('../../Enumerations/CreditDeductionTimings');
const CreditConfigurationStore = require('./CreditConfigurationStore');
const CreditLedger = require('./CreditLedger');

// Best-effort, UX-level gate at the top-level queue endpoints. The Agent
// remains the authoritative charger (it runs every task through the four
// timing hooks); this just lets the server reject an obviously-unaffordable
// request up front instead of launching a pipeline that the Agent will
// immediately refuse.

class CreditPreflight
{
    /**
     * @param {string} userId
     * @param {number} entryTaskType — TaskTypes value of the pipeline's first task
     * @returns {Promise<{allowed: boolean, reason: string, balance: number, required: number, floor: number|null}>}
     */
    static async check(userId, entryTaskType)
    {
        const configuration = await CreditConfigurationStore.load();
        const rule = configuration.getRuleForTask(entryTaskType);

        // No rule configured at all → unmetered → allow (free).
        if (rule === null)
        {
            return { allowed: true, reason: "UNCONFIGURED", balance: 0, required: 0, floor: null };
        }

        // Rule present but disabled → the service is denied, NOT free.
        if (!rule.getEnabled())
        {
            return { allowed: false, reason: "SERVICE_DISABLED", balance: 0, required: 0, floor: null };
        }

        const balance = (await CreditLedger.getBalance(userId)) ?? 0;

        // Entry requirement: the user must already hold at least this much.
        const minimumToRun = rule.getMinimumBalanceToRun();
        if (minimumToRun > 0 && balance < minimumToRun)
        {
            return { allowed: false, reason: "INSUFFICIENT_CREDITS", balance: balance, required: minimumToRun, floor: rule.getMinimumBalanceFloor() };
        }

        // Affordability of the up-front (flat) portion against the floor.
        // The flat cost is only deducted at ON_START; for other timings we
        // still refuse a user already at/under the floor but do not pre-charge.
        const floor = rule.getMinimumBalanceFloor();
        if (floor !== null)
        {
            const flatStartCost = rule.getDeductionTiming() === creditDeductionTimings.ON_START ? rule.evaluate({}) : 0;
            if ((balance - flatStartCost) < floor)
            {
                return { allowed: false, reason: "INSUFFICIENT_CREDITS", balance: balance, required: Math.max(minimumToRun, flatStartCost), floor: floor };
            }
        }

        return { allowed: true, reason: "OK", balance: balance, required: minimumToRun, floor: rule.getMinimumBalanceFloor() };
    }
}

module.exports = CreditPreflight;
