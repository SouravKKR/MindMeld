// One additive term of a CreditSpendRule. The term's cost is its
// `credits` coefficient multiplied by the product of (metric / divisor)
// for every dimension it declares a divisor for. A term with no divisors
// is a flat term — it always contributes its coefficient regardless of
// the metrics, which is what makes ON_START (zero tokens, zero time)
// charge only the flat portion of a rule.
//
// `divisors` is keyed by CreditCostDimensions name (e.g. "INPUT_TOKENS").

class CreditSpendTerm
{
    #credits;
    #divisors;

    constructor({ credits = 0, divisors = {} } = {})
    {
        this.setCredits(credits);
        this.setDivisors(divisors);
    }

    getCredits()
    {
        return this.#credits;
    }

    setCredits(value)
    {
        value = parseFloat(value);
        if (isNaN(value))
        {
            value = 0;
        }
        this.#credits = value;
    }

    getDivisors()
    {
        return this.#divisors;
    }

    setDivisors(value)
    {
        const sanitizedDivisors = {};
        if (value !== null && typeof value === "object")
        {
            for (const dimensionName of Object.keys(value))
            {
                const divisor = parseFloat(value[dimensionName]);
                if (!isNaN(divisor) && divisor > 0)
                {
                    sanitizedDivisors[dimensionName] = divisor;
                }
            }
        }
        this.#divisors = sanitizedDivisors;
    }

    /**
     * Evaluates the term against a metrics object keyed by
     * CreditCostDimensions name. Missing metrics are treated as 0, so a
     * token/time term evaluated at ON_START (empty metrics) yields 0.
     * @param {object} metrics
     * @returns {number}
     */
    evaluate(metrics)
    {
        let amount = this.#credits;

        for (const dimensionName of Object.keys(this.#divisors))
        {
            const divisor = this.#divisors[dimensionName];
            const metricValue = (metrics && typeof metrics[dimensionName] === "number") ? metrics[dimensionName] : 0;
            amount *= (metricValue / divisor);
        }

        return amount;
    }

    toJson()
    {
        return {
            credits: this.getCredits(),
            divisors: { ...this.getDivisors() },
        };
    }

    static fromJson(json)
    {
        return new CreditSpendTerm({
            credits: json?.credits ?? 0,
            divisors: json?.divisors ?? {},
        });
    }
}

module.exports = CreditSpendTerm;
