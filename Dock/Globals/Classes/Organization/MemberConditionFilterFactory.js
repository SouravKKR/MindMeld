const MultiSelectFilter = require("../PaidDeckFilters/MultiSelectFilter");
const DateRangeFilter = require("../PaidDeckFilters/DateRangeFilter");
const NumberRangeFilter = require("../PaidDeckFilters/NumberRangeFilter");
const StringRangeFilter = require("../PaidDeckFilters/StringRangeFilter");
const TextSearchFilter = require("../PaidDeckFilters/TextSearchFilter");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");


/**
 * MemberConditionFilterFactory
 *
 * Rebuilds the filter object behind one stored rule condition.
 *
 * A saved condition records the type and field it was written against, so it can
 * be turned back into the very filter the roster screen used and asked for its
 * Mongo fragment. That indirection is the point: it keeps `toMongoQuery` the one
 * definition of what a range means, whether the caller is listing members,
 * previewing a rule, or deciding a member's features on a live request.
 *
 * A condition whose type this does not recognise yields null, and every caller
 * treats null as "this condition selects nobody" rather than skipping it. A
 * skipped condition would widen the rule to everyone it was meant to exclude,
 * which for a feature grant is the wrong way to fail.
 */
class MemberConditionFilterFactory
{
    /**
     * @param {object} condition { key, type, field }
     * @returns {PaidDeckFilter|null}
     */
    static create(condition)
    {
        if (!condition || typeof condition !== "object")
        {
            return null;
        }

        const key = typeof condition.key === "string" ? condition.key : "";
        const field = typeof condition.field === "string" ? condition.field : "";
        if (key.length === 0 || field.length === 0)
        {
            return null;
        }

        // The label never reaches the query; the filter classes simply require
        // one, and the key is the most honest thing to give them.
        const label = key;

        if (condition.type === paidDeckFilterTypes.NUMBER_RANGE)
        {
            return new NumberRangeFilter({ key: key, label: label, field: field });
        }

        if (condition.type === paidDeckFilterTypes.DATE_RANGE)
        {
            // The comparable copy holds an ISO string for a date column, so the
            // bounds must be emitted as ISO strings too — a Date object compared
            // against a stored string matches nothing in Mongo.
            return new DateRangeFilter({ key: key, label: label, field: field, compareAsIsoString: field.startsWith("attributesComparable.") });
        }

        if (condition.type === paidDeckFilterTypes.STRING_RANGE)
        {
            return new StringRangeFilter({ key: key, label: label, field: field });
        }

        if (condition.type === paidDeckFilterTypes.MULTI_SELECT)
        {
            return new MultiSelectFilter({ key: key, label: label, field: field, options: [] });
        }

        if (condition.type === paidDeckFilterTypes.TEXT_SEARCH)
        {
            return new TextSearchFilter({ key: key, label: label, fields: [field] });
        }

        return null;
    }

    /**
     * Whether a condition names a filter type that can be rebuilt at all. Used
     * on the write path so a rule carrying something unusable is refused when it
     * is saved, rather than quietly selecting nobody afterwards.
     *
     * @param {object} condition
     * @returns {boolean}
     */
    static isSupported(condition)
    {
        return MemberConditionFilterFactory.create(condition) !== null;
    }
}

module.exports = MemberConditionFilterFactory;
