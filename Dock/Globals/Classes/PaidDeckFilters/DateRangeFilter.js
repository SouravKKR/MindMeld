const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * DateRangeFilter
 *
 * Inclusive [from, to] date range. Accepts ISO-8601 strings (so the JSON
 * payload is portable) and coerces them to Date objects for the query.
 * Outputs a single { field: { $gte, $lte } } fragment.
 */
class DateRangeFilter extends PaidDeckFilter
{
    #field;

    constructor({ key, label, field })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.DATE_RANGE });

        if (!field)
        {
            throw new Error("DateRangeFilter requires a field name");
        }

        this.#field = field;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return { ...baseMetadata, field: this.#field };
    }

    #parseIsoDate(maybeIsoString)
    {
        if (!maybeIsoString)
        {
            return null;
        }

        const parsed = new Date(maybeIsoString);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    isValueEmpty(value)
    {
        if (!value || typeof value !== "object")
        {
            return true;
        }

        return this.#parseIsoDate(value.from) === null && this.#parseIsoDate(value.to) === null;
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const fromDate = this.#parseIsoDate(value.from);
        const toDate = this.#parseIsoDate(value.to);

        const rangeClause = {};

        if (fromDate !== null)
        {
            rangeClause.$gte = fromDate;
        }

        if (toDate !== null)
        {
            rangeClause.$lte = toDate;
        }

        const queryFragment = {};
        queryFragment[this.#field] = rangeClause;
        return queryFragment;
    }
}

module.exports = DateRangeFilter;
