const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * NumberRangeFilter
 *
 * Inclusive [min, max] range. Output is a single { field: { $gte, $lte } }
 * fragment so Mongo can use a numeric index on the field for a bounded
 * scan instead of a full-collection sweep.
 */
class NumberRangeFilter extends PaidDeckFilter
{
    #field;
    #defaultMin;
    #defaultMax;
    #step;

    constructor({ key, label, field, defaultMin = null, defaultMax = null, step = 1 })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.NUMBER_RANGE });

        if (!field)
        {
            throw new Error("NumberRangeFilter requires a field name");
        }

        this.#field = field;
        this.#defaultMin = defaultMin;
        this.#defaultMax = defaultMax;
        this.#step = step;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return {
            ...baseMetadata,
            field: this.#field,
            defaultMin: this.#defaultMin,
            defaultMax: this.#defaultMax,
            step: this.#step
        };
    }

    isValueEmpty(value)
    {
        if (!value || typeof value !== "object")
        {
            return true;
        }

        const hasMin = typeof value.min === "number" && Number.isFinite(value.min);
        const hasMax = typeof value.max === "number" && Number.isFinite(value.max);

        return !hasMin && !hasMax;
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const rangeClause = {};

        if (typeof value.min === "number" && Number.isFinite(value.min))
        {
            rangeClause.$gte = value.min;
        }

        if (typeof value.max === "number" && Number.isFinite(value.max))
        {
            rangeClause.$lte = value.max;
        }

        const queryFragment = {};
        queryFragment[this.#field] = rangeClause;
        return queryFragment;
    }
}

module.exports = NumberRangeFilter;
