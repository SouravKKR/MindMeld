const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * EnumFilter
 *
 * Single-choice equality filter. { field: chosenValue } query fragment.
 * Use for properties with a small, known set of values where multi-
 * select doesn't make sense (e.g. granularity: INDIVIDUAL vs BUNDLE_ONLY).
 */
class EnumFilter extends PaidDeckFilter
{
    #field;
    #options;

    constructor({ key, label, field, options })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.ENUM });

        if (!field)
        {
            throw new Error("EnumFilter requires a field name");
        }

        if (!Array.isArray(options) || options.length === 0)
        {
            throw new Error("EnumFilter requires a non-empty options array");
        }

        this.#field = field;
        this.#options = options;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return { ...baseMetadata, field: this.#field, options: this.#options };
    }

    isValueEmpty(value)
    {
        return value === null || value === undefined || value === "";
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

module.exports = EnumFilter;
