const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * BooleanFilter
 *
 * Three-state filter: true, false, or unset. When unset the filter
 * contributes nothing to the query, so the user can leave it neutral.
 */
class BooleanFilter extends PaidDeckFilter
{
    #field;

    constructor({ key, label, field })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.BOOLEAN });

        if (!field)
        {
            throw new Error("BooleanFilter requires a field name");
        }

        this.#field = field;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return { ...baseMetadata, field: this.#field };
    }

    isValueEmpty(value)
    {
        return typeof value !== "boolean";
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const queryFragment = {};
        queryFragment[this.#field] = value;
        return queryFragment;
    }
}

module.exports = BooleanFilter;
