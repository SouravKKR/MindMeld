const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * TextSearchFilter
 *
 * Case-insensitive substring search across one or more fields. Outputs a
 * $or of $regex fragments — Mongo can use a regular ascending index on
 * each field to bound the scan when the regex is anchored ("^foo"), and
 * still falls back to a collection scan for free-text middle-of-string
 * matches. For high-traffic deployments swap to a $text index on the
 * same fields, but $text loses the partial-prefix semantics we want.
 */
class TextSearchFilter extends PaidDeckFilter
{
    #fields;

    constructor({ key, label, fields })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.TEXT_SEARCH });

        if (!Array.isArray(fields) || fields.length === 0)
        {
            throw new Error("TextSearchFilter requires a non-empty fields array");
        }

        this.#fields = fields;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return { ...baseMetadata, fields: this.#fields };
    }

    isValueEmpty(value)
    {
        return typeof value !== "string" || value.trim().length === 0;
    }

    #escapeRegex(rawString)
    {
        return rawString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const escapedPattern = this.#escapeRegex(value.trim());
        const caseInsensitiveRegex = { $regex: escapedPattern, $options: "i" };

        const orClauses = this.#fields.map(fieldName =>
        {
            const clause = {};
            clause[fieldName] = caseInsensitiveRegex;
            return clause;
        });

        return { $or: orClauses };
    }
}

module.exports = TextSearchFilter;
