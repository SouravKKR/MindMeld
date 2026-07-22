const { billingCycleUnits } = require("../../Enumerations/BillingCycleUnits");

// UTC-safe duration arithmetic for the two coupon durations (redemption window
// and benefit span) and any other value+unit span. All math is in UTC so a
// month/year addition never drifts by a DST hour, and day additions are exact
// millisecond steps.

class DurationConverter
{
    static #MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

    /**
     * Adds a value+unit duration to a base epoch-millisecond timestamp and
     * returns the resulting epoch milliseconds. A non-positive value returns the
     * base unchanged.
     * @param {number} baseMilliseconds
     * @param {number} value
     * @param {number} unit — billingCycleUnits value
     * @returns {number}
     */
    static addDuration(baseMilliseconds, value, unit)
    {
        const base = Number(baseMilliseconds);
        const numericValue = Number(value);
        if (isNaN(base) || isNaN(numericValue) || numericValue <= 0)
        {
            return base;
        }

        if (Number(unit) === billingCycleUnits.DAY)
        {
            return base + numericValue * DurationConverter.#MILLISECONDS_PER_DAY;
        }

        const date = new Date(base);
        if (Number(unit) === billingCycleUnits.MONTH)
        {
            date.setUTCMonth(date.getUTCMonth() + numericValue);
        }
        else if (Number(unit) === billingCycleUnits.YEAR)
        {
            date.setUTCFullYear(date.getUTCFullYear() + numericValue);
        }
        else
        {
            // Unknown unit — treat as days so a misconfiguration never yields a
            // zero-length or infinite span silently.
            return base + numericValue * DurationConverter.#MILLISECONDS_PER_DAY;
        }
        return date.getTime();
    }

    static isValidUnit(unit)
    {
        return Object.values(billingCycleUnits).includes(Number(unit));
    }
}

module.exports = DurationConverter;
