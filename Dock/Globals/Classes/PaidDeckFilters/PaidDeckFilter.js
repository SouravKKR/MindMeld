/**
 * PaidDeckFilter
 *
 * Abstract base for every server-side paid-deck filter. The contract is
 * intentionally narrow so MongoDB does the work:
 *
 *   - getMetadata() describes the filter to the client (key, label,
 *     type, field, plus any type-specific options like min/max or
 *     selectable values). The client renders a UI input purely from
 *     this metadata — no hand-written switch statements per filter.
 *
 *   - toMongoQuery(value) translates a client-submitted value into a
 *     MongoDB query fragment. The PaidDeckSearchEngine $and-s every
 *     fragment together into a single query, so the database itself
 *     does the filtering with index assistance instead of any in-memory
 *     post-filter on the Node side.
 *
 *   - isValueEmpty(value) lets the search engine drop fragments the
 *     user didn't actually fill in (an empty range, an unselected
 *     multi-select, a blank text query, etc.) so the resulting query
 *     stays as narrow as the data the user supplied.
 *
 * Subclasses MUST implement toMongoQuery and isValueEmpty. getMetadata
 * has a default implementation that returns the constructor config.
 */
class PaidDeckFilter
{
    #key;
    #label;
    #type;

    constructor({ key, label, type })
    {
        if (!key || !label || type === undefined)
        {
            throw new Error("PaidDeckFilter requires key, label and type");
        }

        this.#key = key;
        this.#label = label;
        this.#type = type;
    }

    getKey()
    {
        return this.#key;
    }

    getLabel()
    {
        return this.#label;
    }

    getType()
    {
        return this.#type;
    }

    async getMetadata(database)
    {
        return {
            key: this.#key,
            label: this.#label,
            type: this.#type
        };
    }

    isValueEmpty(value)
    {
        throw new Error("PaidDeckFilter.isValueEmpty() must be implemented by subclass");
    }

    toMongoQuery(value)
    {
        throw new Error("PaidDeckFilter.toMongoQuery() must be implemented by subclass");
    }
}

module.exports = PaidDeckFilter;
