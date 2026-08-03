const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * EnumFilter
 *
 * Single-choice equality filter. { field: chosenValue } query fragment.
 * Use for properties with a small, known set of values where multi-
 * select doesn't make sense (e.g. granularity: INDIVIDUAL vs BUNDLE_ONLY).
 *
 * The submitted value is resolved against the registered options and the query
 * is then built from the OPTION's value, never from the client's. That is what
 * stops a submitted object such as `{"$ne": null}` from reaching Mongo as a
 * query operator instead of an equality match, and it also normalises the
 * "0" / 0 spelling difference a <select> element introduces.
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

        const matchedOption = this.#findMatchingOption(value);

        // An unrecognised value contributes nothing rather than being passed
        // through, so the filter behaves exactly as it does when left unset.
        if (matchedOption === null)
        {
            return null;
        }

        const queryFragment = {};
        queryFragment[this.#field] = EnumFilter.#valueOfOption(matchedOption);
        return queryFragment;
    }

    /**
     * Returns the registered option the submitted value refers to, or null when
     * it refers to none.
     *
     * Only primitives are considered — refusing objects and arrays outright is
     * what closes the operator-injection path, since neither can then reach the
     * query fragment. A <select> hands its value back as a string, so "0" has
     * to resolve to the numeric option 0; the comparison therefore falls back
     * to a string form once the strict check misses.
     *
     * @param {*} value the value submitted by the client
     *
     * @returns {*} the matching option entry, or null
     */
    #findMatchingOption(value)
    {
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        {
            return null;
        }

        for (const option of this.#options)
        {
            const optionValue = EnumFilter.#valueOfOption(option);

            if (optionValue === value || String(optionValue) === String(value))
            {
                return option;
            }
        }

        return null;
    }

    /**
     * Unwraps an option entry, which may be either a { value, label } pair or a
     * bare scalar.
     *
     * @param {*} option the registered option entry
     *
     * @returns {*} the option's value
     */
    static #valueOfOption(option)
    {
        return (option !== null && typeof option === "object") ? option.value : option;
    }
}

module.exports = EnumFilter;
