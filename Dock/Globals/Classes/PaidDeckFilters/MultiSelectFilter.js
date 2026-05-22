const PaidDeckFilter = require("./PaidDeckFilter");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * MultiSelectFilter
 *
 * { field: { $in: [chosenValues...] } } query fragment. Works on both
 * scalar fields (category) and array fields (tags) — Mongo's $in matches
 * "any element of the array equals one of the chosen values" which is
 * the right semantics in both cases.
 *
 * Options can be:
 *   - static (passed in via constructor options[])
 *   - dynamic (discovered by running $distinct on the source field at
 *     metadata-fetch time, so admin-added categories surface in the UI
 *     without restarting Dock)
 *
 * For dynamic options the filter declares which collection + field to
 * pull distinct values from.
 */
class MultiSelectFilter extends PaidDeckFilter
{
    #field;
    #staticOptions;
    #dynamicSource;

    constructor({ key, label, field, options = null, dynamicSource = null })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.MULTI_SELECT });

        if (!field)
        {
            throw new Error("MultiSelectFilter requires a field name");
        }

        if (options === null && dynamicSource === null)
        {
            throw new Error("MultiSelectFilter requires either static options or a dynamicSource");
        }

        this.#field = field;
        this.#staticOptions = Array.isArray(options) ? options : null;
        this.#dynamicSource = dynamicSource;
    }

    async #fetchDynamicOptions(database)
    {
        if (!database || !this.#dynamicSource)
        {
            return [];
        }

        const collectionName = this.#dynamicSource.collection || DatabaseConstants.PAID_DECKS_COLLECTION;
        const sourceField = this.#dynamicSource.field || this.#field;
        const baseFilter = this.#dynamicSource.baseFilter || {};

        const distinctValues = await database
            .collection(collectionName)
            .distinct(sourceField, baseFilter);

        return distinctValues
            .filter(value => value !== null && value !== undefined && value !== "")
            .sort();
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);

        const resolvedOptions = this.#staticOptions !== null
            ? this.#staticOptions
            : await this.#fetchDynamicOptions(database);

        return {
            ...baseMetadata,
            field: this.#field,
            options: resolvedOptions
        };
    }

    isValueEmpty(value)
    {
        return !Array.isArray(value) || value.length === 0;
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const queryFragment = {};
        queryFragment[this.#field] = { $in: value };
        return queryFragment;
    }
}

module.exports = MultiSelectFilter;
