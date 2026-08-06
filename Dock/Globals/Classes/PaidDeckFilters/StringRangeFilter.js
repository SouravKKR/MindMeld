const PaidDeckFilter = require("./PaidDeckFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * StringRangeFilter
 *
 * Inclusive [start, end] range over a TEXT field — the third range type
 * alongside NumberRange and DateRange, so a caller can select "roll numbers
 * A0100 through A0450" or "names Aa through Mz" the same way they select a
 * number or a date span.
 *
 * Both ends are inclusive, which is why `end` is compared with `$lte` against
 * the end value plus the highest code point Mongo will sort after it. A plain
 * `$lte: "Mz"` would exclude "Mza", so a user asking for "up to Mz" would
 * silently lose every longer string that starts with it.
 *
 * Comparison is case-insensitive by default because the values these ranges run
 * over — names, roll numbers, streams — are typed by hand into a spreadsheet,
 * where "a0100" and "A0100" are the same identifier. Mongo compares strings by
 * byte order, in which every uppercase letter sorts before every lowercase one,
 * so a case-sensitive range would put "apple" outside [A, M] entirely. The
 * comparison therefore runs against a lowercased copy of the field, which the
 * caller supplies through `field` (the member importer stores one).
 */
class StringRangeFilter extends PaidDeckFilter
{
    // Appended to the end bound so the upper end of the range is inclusive of
    // every string that merely EXTENDS it. ￿ is above every character that
    // appears in real data, so "Mz" + ￿ sorts after "Mza" but before "N".
    static INCLUSIVE_END_SUFFIX = "￿";

    #field;
    #bCaseInsensitive;

    constructor({ key, label, field, bCaseInsensitive = true })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.STRING_RANGE });

        if (!field)
        {
            throw new Error("StringRangeFilter requires a field name");
        }

        this.#field = field;
        this.#bCaseInsensitive = bCaseInsensitive === true;
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        return {
            ...baseMetadata,
            field: this.#field,
            caseInsensitive: this.#bCaseInsensitive
        };
    }

    isValueEmpty(value)
    {
        if (!value || typeof value !== "object")
        {
            return true;
        }

        const bHasStart = typeof value.start === "string" && value.start.trim().length > 0;
        const bHasEnd = typeof value.end === "string" && value.end.trim().length > 0;

        return !bHasStart && !bHasEnd;
    }

    /**
     * Normalises one bound the same way the stored value was normalised, so the
     * comparison is between like and like.
     */
    #normaliseBound(rawBound)
    {
        const trimmed = String(rawBound).trim();
        return this.#bCaseInsensitive ? trimmed.toLowerCase() : trimmed;
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const rangeClause = {};

        if (typeof value.start === "string" && value.start.trim().length > 0)
        {
            rangeClause.$gte = this.#normaliseBound(value.start);
        }

        if (typeof value.end === "string" && value.end.trim().length > 0)
        {
            rangeClause.$lte = this.#normaliseBound(value.end) + StringRangeFilter.INCLUSIVE_END_SUFFIX;
        }

        const queryFragment = {};
        queryFragment[this.#field] = rangeClause;
        return queryFragment;
    }
}

module.exports = StringRangeFilter;
