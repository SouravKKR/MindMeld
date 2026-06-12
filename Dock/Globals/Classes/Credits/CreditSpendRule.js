const { creditDeductionTimings } = require('../../Enumerations/CreditDeductionTimings');
const CreditSpendTerm = require('./CreditSpendTerm');

// A composable spend rule for a single chargeable subject (an agent task
// type or a storage category). Cost is the sum of its terms; `deductionTiming`
// decides WHEN the charge fires and `minimumBalanceFloor` decides how far
// below zero this particular charge may push the balance.

class CreditSpendRule
{
    #enabled;
    #deductionTiming;
    #intervalSeconds;
    #minimumBalanceToRun;
    #minimumBalanceFloor;
    #terms;

    static DEFAULT_INTERVAL_SECONDS = 30;

    constructor({ enabled = false, deductionTiming = creditDeductionTimings.ON_SUCCESS, intervalSeconds = CreditSpendRule.DEFAULT_INTERVAL_SECONDS, minimumBalanceToRun = 0, minimumBalanceFloor = 0, terms = [] } = {})
    {
        this.setEnabled(enabled);
        this.setDeductionTiming(deductionTiming);
        this.setIntervalSeconds(intervalSeconds);
        this.setMinimumBalanceToRun(minimumBalanceToRun);
        this.setMinimumBalanceFloor(minimumBalanceFloor);
        this.setTerms(terms);
    }

    /**
     * The minimum balance a user must already hold for this task to be allowed
     * to run at all. 0 = no entry requirement. Distinct from the floor: this
     * gates whether the task starts; the floor bounds how far the charge may
     * push the balance once it does.
     */
    getMinimumBalanceToRun()
    {
        return this.#minimumBalanceToRun;
    }

    setMinimumBalanceToRun(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value < 0)
        {
            value = 0;
        }
        this.#minimumBalanceToRun = value;
    }

    getEnabled()
    {
        return this.#enabled;
    }

    setEnabled(value)
    {
        this.#enabled = Boolean(value);
    }

    getDeductionTiming()
    {
        return this.#deductionTiming;
    }

    setDeductionTiming(value)
    {
        const enumValues = Object.values(creditDeductionTimings);
        if (!enumValues.includes(value))
        {
            value = creditDeductionTimings.ON_SUCCESS;
        }
        this.#deductionTiming = value;
    }

    getIntervalSeconds()
    {
        return this.#intervalSeconds;
    }

    setIntervalSeconds(value)
    {
        value = parseFloat(value);
        if (isNaN(value) || value <= 0)
        {
            value = CreditSpendRule.DEFAULT_INTERVAL_SECONDS;
        }
        this.#intervalSeconds = value;
    }

    /**
     * The lowest balance this charge may leave behind:
     *   0    → no negative allowed (block when it would cross zero)
     *   -N   → balance may go as low as -N
     *   null → unlimited (always allowed)
     */
    getMinimumBalanceFloor()
    {
        return this.#minimumBalanceFloor;
    }

    setMinimumBalanceFloor(value)
    {
        if (value === null || value === undefined || value === "")
        {
            this.#minimumBalanceFloor = null;
            return;
        }
        value = parseFloat(value);
        if (isNaN(value))
        {
            value = 0;
        }
        this.#minimumBalanceFloor = value;
    }

    getTerms()
    {
        return this.#terms;
    }

    setTerms(value)
    {
        const terms = [];
        if (Array.isArray(value))
        {
            for (const entry of value)
            {
                terms.push(entry instanceof CreditSpendTerm ? entry : CreditSpendTerm.fromJson(entry));
            }
        }
        this.#terms = terms;
    }

    /**
     * Sums every term against the given metrics. With empty metrics only
     * flat terms contribute, which is exactly the ON_START semantics.
     * @param {object} metrics — keyed by CreditCostDimensions name
     * @returns {number}
     */
    evaluate(metrics = {})
    {
        let total = 0;
        for (const term of this.#terms)
        {
            total += term.evaluate(metrics);
        }
        return total;
    }

    toJson()
    {
        return {
            enabled: this.getEnabled(),
            deductionTiming: this.getDeductionTiming(),
            intervalSeconds: this.getIntervalSeconds(),
            minimumBalanceToRun: this.getMinimumBalanceToRun(),
            minimumBalanceFloor: this.getMinimumBalanceFloor(),
            terms: this.getTerms().map(term => term.toJson()),
        };
    }

    static fromJson(json)
    {
        return new CreditSpendRule({
            enabled: json?.enabled ?? false,
            deductionTiming: json?.deductionTiming ?? creditDeductionTimings.ON_SUCCESS,
            intervalSeconds: json?.intervalSeconds ?? CreditSpendRule.DEFAULT_INTERVAL_SECONDS,
            minimumBalanceToRun: json?.minimumBalanceToRun === undefined ? 0 : json.minimumBalanceToRun,
            minimumBalanceFloor: json?.minimumBalanceFloor === undefined ? 0 : json.minimumBalanceFloor,
            terms: json?.terms ?? [],
        });
    }
}

module.exports = CreditSpendRule;
