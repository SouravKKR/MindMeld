const AdminListDefinition = require("../AdminLists/AdminListDefinition");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const OrganizationMemberProfileNormaliser = require("./OrganizationMemberProfileNormaliser");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const TextSearchFilter = require("../PaidDeckFilters/TextSearchFilter");
const MultiSelectFilter = require("../PaidDeckFilters/MultiSelectFilter");
const DateRangeFilter = require("../PaidDeckFilters/DateRangeFilter");
const NumberRangeFilter = require("../PaidDeckFilters/NumberRangeFilter");
const StringRangeFilter = require("../PaidDeckFilters/StringRangeFilter");
const { adminListTypes } = require("../../Enumerations/AdminListTypes");
const { memberAttributeValueTypes } = require("../../Enumerations/MemberAttributeValueTypes");


/**
 * OrganizationMemberListBuilder
 *
 * Builds the member list for ONE organization — its filters, its columns and
 * the Mongo query behind them — so the roster is searched, filtered, sorted and
 * paged by the database rather than by fetching every member and slicing them
 * in the browser, which is what it did before.
 *
 * The filter set is built per organization from the attribute keys and tags
 * actually in use, because an institute that uploads "stream" and one that
 * uploads "section" do not want each other's filters. A key is offered as a
 * NUMBER range when every stored value parses as a number (join years, marks),
 * as a DATE range when every value parses as a date, and as a STRING range
 * otherwise (names, roll numbers) — one inclusive start/end control either way,
 * which is what makes "select a range" mean the same thing whatever the column
 * holds.
 *
 * The organizationId is never taken from the request body: the caller resolves
 * it through OrganizationAuthorityResolver and passes it in, so a filter
 * payload cannot reach another organization's roster.
 */
class OrganizationMemberListBuilder
{
    static FILTER_KEY_TAGS = "tags";
    static FILTER_KEY_ADDED_AT = "addedAt";
    static ATTRIBUTE_FILTER_KEY_PREFIX = "attribute:";

    // How many members to sample when deciding whether an attribute reads as a
    // number, a date or plain text. The whole roster is unnecessary — a
    // consistent column shows its type in the first handful of rows, and an
    // inconsistent one falls back to text, which always works.
    static TYPE_SAMPLE_SIZE = 50;

    /**
     * @param {object} database
     * @param {string} organizationId
     * @returns {Promise<{ definition: AdminListDefinition, attributeKeys: string[] }>}
     */
    static async build(database, organizationId)
    {
        const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);
        const attributeTypes = await OrganizationMemberListBuilder.#resolveAttributeTypes(database, organizationId, vocabulary.attributeKeys);

        const filters = [];

        if (vocabulary.tags.length > 0)
        {
            filters.push(new MultiSelectFilter
            ({
                key: OrganizationMemberListBuilder.FILTER_KEY_TAGS,
                label: "Tags",
                field: "tags",
                // Plain strings, matching every other MultiSelectFilter in the
                // codebase. A tag is already the text a person reads, so a
                // separate label would only be a second thing to keep in step.
                options: vocabulary.tags
            }));
        }

        filters.push(new DateRangeFilter
        ({
            key: OrganizationMemberListBuilder.FILTER_KEY_ADDED_AT,
            label: "Added",
            field: "addedAt"
        }));

        for (const attributeKey of vocabulary.attributeKeys)
        {
            filters.push(OrganizationMemberListBuilder.#buildAttributeFilter(attributeKey, attributeTypes[attributeKey]));
        }

        const columns =
        [
            { key: "email", label: "Email" },
            { key: "accountLabel", label: "Account" },
            { key: "tagsLabel", label: "Tags" },
            ...vocabulary.attributeKeys.map(attributeKey => (
            {
                key: `attribute_${attributeKey}`,
                label: OrganizationMemberListBuilder.#describeAttributeKey(attributeKey)
            })),
            { key: "addedAtLabel", label: "Added" }
        ];

        const definition = new AdminListDefinition
        ({
            listKey: adminListTypes.ORGANIZATION_MEMBERS,
            collectionName: DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION,
            // Server-supplied and not expressible as a filter, so no client
            // payload can reach another organization's roster.
            baseQuery: { organizationId: organizationId },
            searchableFields: ["email", ...vocabulary.attributeKeys.map(attributeKey => `attributes.${attributeKey}`)],
            searchPlaceholder: "Search by email or details",
            filters: filters,
            columns: columns,
            rowMapper: (document) => OrganizationMemberListBuilder.#mapRow(document, vocabulary.attributeKeys),
            defaultSort: { field: "addedAt", direction: -1 },
            sortableFields: ["email", "addedAt"],
            rowIdField: "id"
        });

        return { definition: definition, attributeKeys: vocabulary.attributeKeys };
    }

    /**
     * The Mongo fragment for a submitted filter payload, scoped to one
     * organization. Shared by the list query and by filtered removal, so a
     * preview, a page of results and a deletion can never disagree about what
     * the filter means.
     *
     * @param {AdminListDefinition} definition
     * @param {object} filterValuesByKey
     * @param {string} searchValue
     * @returns {object} a Mongo query fragment WITHOUT the organization scope
     */
    static buildFilterQuery(definition, filterValuesByKey, searchValue)
    {
        const queryParts = [];

        const searchableFields = definition.getSearchableFields();
        if (searchableFields.length > 0 && typeof searchValue === "string" && searchValue.trim().length > 0)
        {
            const searchFilter = new TextSearchFilter({ key: "search", label: "Search", fields: searchableFields });
            const searchFragment = searchFilter.toMongoQuery(searchValue);
            if (searchFragment)
            {
                queryParts.push(searchFragment);
            }
        }

        for (const filter of definition.getFilters())
        {
            const submittedValue = (filterValuesByKey || {})[filter.getKey()];
            if (submittedValue === undefined)
            {
                continue;
            }
            const fragment = filter.toMongoQuery(submittedValue);
            if (fragment !== null && fragment !== undefined)
            {
                queryParts.push(fragment);
            }
        }

        if (queryParts.length === 0)
        {
            return {};
        }

        return { $and: queryParts };
    }

    /**
     * True when a filter payload actually narrows anything. Filtered removal
     * refuses an empty one: "delete everyone who matches no criteria" is how a
     * whole roster disappears by accident.
     */
    static isFilterQueryEmpty(filterQuery)
    {
        return !filterQuery || Object.keys(filterQuery).length === 0;
    }

    static #buildAttributeFilter(attributeKey, valueType)
    {
        const label = OrganizationMemberListBuilder.#describeAttributeKey(attributeKey);
        const filterKey = `${OrganizationMemberListBuilder.ATTRIBUTE_FILTER_KEY_PREFIX}${attributeKey}`;

        if (valueType === memberAttributeValueTypes.NUMBER)
        {
            return new NumberRangeFilter
            ({
                key: filterKey,
                label: label,
                field: `attributesComparable.${attributeKey}`
            });
        }

        if (valueType === memberAttributeValueTypes.DATE)
        {
            // The comparable copy holds an ISO string for a date attribute, so
            // the filter compares ISO to ISO — those sort chronologically, and
            // a Date object compared against a stored string would match
            // nothing at all.
            return new DateRangeFilter
            ({
                key: filterKey,
                label: label,
                field: `attributesComparable.${attributeKey}`,
                compareAsIsoString: true
            });
        }

        // Text ranges compare against the lowercased copy, because Mongo orders
        // strings by byte value and would otherwise sort every capitalised name
        // before every lowercase one.
        return new StringRangeFilter
        ({
            key: filterKey,
            label: label,
            field: `attributesNormalised.${attributeKey}`
        });
    }

    /**
     * Decides how each attribute reads, from a bounded sample of real values.
     */
    static async #resolveAttributeTypes(database, organizationId, attributeKeys)
    {
        const attributeTypes = {};
        if (attributeKeys.length === 0)
        {
            return attributeTypes;
        }

        const sampleDocuments = await database
            .collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION)
            .find({ organizationId: organizationId }, { projection: { _id: 0, attributes: 1 } })
            .limit(OrganizationMemberListBuilder.TYPE_SAMPLE_SIZE)
            .toArray();

        for (const attributeKey of attributeKeys)
        {
            let observedCount = 0;
            let numericCount = 0;
            let dateCount = 0;

            for (const sampleDocument of sampleDocuments)
            {
                const rawValue = sampleDocument?.attributes?.[attributeKey];
                if (typeof rawValue !== "string" || rawValue.length === 0)
                {
                    continue;
                }

                observedCount = observedCount + 1;

                // Ask the normaliser, so what the filter offers and what was
                // stored can never disagree about whether a value is a number.
                const comparableValue = OrganizationMemberProfileNormaliser.toComparableValue(rawValue);
                if (typeof comparableValue === "number")
                {
                    numericCount = numericCount + 1;
                }
                else if (typeof comparableValue === "string")
                {
                    dateCount = dateCount + 1;
                }
            }

            if (observedCount > 0 && numericCount === observedCount)
            {
                attributeTypes[attributeKey] = memberAttributeValueTypes.NUMBER;
            }
            else if (observedCount > 0 && dateCount === observedCount)
            {
                attributeTypes[attributeKey] = memberAttributeValueTypes.DATE;
            }
            else
            {
                attributeTypes[attributeKey] = memberAttributeValueTypes.STRING;
            }
        }

        return attributeTypes;
    }

    static #describeAttributeKey(attributeKey)
    {
        const spaced = String(attributeKey).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }

    static #mapRow(document, attributeKeys)
    {
        const row =
        {
            id: document.id,
            email: document.email,
            accountLabel: document.userId ? "Signed in" : "Not yet signed in",
            tagsLabel: Array.isArray(document.tags) && document.tags.length > 0 ? document.tags.join(", ") : "—",
            addedAtLabel: document.addedAt ? new Date(document.addedAt).toISOString().slice(0, 10) : "",
            delegatePowers: Number.isInteger(document.delegatePowers) ? document.delegatePowers : 0,
            userId: document.userId || "",
            tags: Array.isArray(document.tags) ? document.tags : []
        };

        for (const attributeKey of attributeKeys)
        {
            row[`attribute_${attributeKey}`] = document?.attributes?.[attributeKey] || "";
        }

        return row;
    }
}

module.exports = OrganizationMemberListBuilder;
