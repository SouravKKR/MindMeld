const AdminListDefinition = require("../AdminLists/AdminListDefinition");
const OrganizationMemberQueryEngine = require("./OrganizationMemberQueryEngine");
const OrganizationMemberColumnQueryEngine = require("./OrganizationMemberColumnQueryEngine");
const OrganizationMemberColumnBackfiller = require("./OrganizationMemberColumnBackfiller");
const MemberAttributeTypeInferrer = require("./MemberAttributeTypeInferrer");
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
 * The filter set is built per organization from the columns and tags actually in
 * use, because an institute that uploads "stream" and one that uploads "section"
 * do not want each other's filters. A key is offered as a NUMBER range when its
 * values are numbers (join years, marks), as a DATE range when they are dates,
 * and as a STRING range otherwise (names, roll numbers) — one inclusive
 * start/end control either way, which is what makes "select a range" mean the
 * same thing whatever the column holds.
 *
 * Which of those a column IS comes from the institute's own schema
 * (OrganizationMemberColumnQueryEngine), falling back to inference only for a
 * key nobody has described yet. The order matters: sampling values is a guess,
 * and a single "N/A" in a column of admission years is enough to turn a year
 * range into an alphabetical one for the entire roster. The stated answer wins.
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

    /**
     * @param {object} database
     * @param {string} organizationId
     * @returns {Promise<{ definition: AdminListDefinition, attributeKeys: string[], memberColumns: Array<OrganizationMemberColumn> }>}
     */
    static async build(database, organizationId)
    {
        const vocabulary = await OrganizationMemberQueryEngine.listProfileVocabulary(organizationId);

        // Give this organization a column schema if it does not have one yet, so
        // a roster imported before columns existed is described the same way a
        // roster imported today is. Existing rows are never overwritten, so the
        // institute's own labels and type corrections survive.
        await OrganizationMemberColumnBackfiller.backfillForOrganization(database, organizationId);
        const columns = await OrganizationMemberColumnQueryEngine.listColumnsForOrganization(organizationId);
        const columnsByKey = new Map(columns.map(column => [column.getKey(), column]));

        // The schema's order first, then anything stored but not yet described —
        // which is what a member document carries in the window between an import
        // and its column row existing.
        const orderedAttributeKeys = [];
        for (const column of columns)
        {
            if (vocabulary.attributeKeys.includes(column.getKey()))
            {
                orderedAttributeKeys.push(column.getKey());
            }
        }
        for (const attributeKey of vocabulary.attributeKeys)
        {
            if (!columnsByKey.has(attributeKey))
            {
                orderedAttributeKeys.push(attributeKey);
            }
        }

        // Sampling only answers for keys the schema does not describe. Where the
        // institute has stated a type, that is the answer — a column of years
        // holding one "N/A" must not silently become a text range for everybody.
        const undescribedKeys = orderedAttributeKeys.filter(attributeKey => !columnsByKey.has(attributeKey));
        const sampledTypes = await MemberAttributeTypeInferrer.inferTypes(database, organizationId, undescribedKeys);

        const attributeTypes = {};
        const attributeLabels = {};
        for (const attributeKey of orderedAttributeKeys)
        {
            const column = columnsByKey.get(attributeKey);
            attributeTypes[attributeKey] = column ? column.getValueType() : sampledTypes[attributeKey];
            attributeLabels[attributeKey] = column
                ? column.getLabel()
                : OrganizationMemberColumnQueryEngine.describeAttributeKey(attributeKey);
        }

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

        for (const attributeKey of orderedAttributeKeys)
        {
            filters.push(OrganizationMemberListBuilder.#buildAttributeFilter(attributeKey, attributeTypes[attributeKey], attributeLabels[attributeKey]));
        }

        const listColumns =
        [
            { key: "email", label: "Email" },
            { key: "accountLabel", label: "Account" },
            { key: "tagsLabel", label: "Tags" },
            ...orderedAttributeKeys.map(attributeKey => (
            {
                key: `attribute_${attributeKey}`,
                label: attributeLabels[attributeKey]
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
            searchableFields: ["email", ...orderedAttributeKeys.map(attributeKey => `attributes.${attributeKey}`)],
            searchPlaceholder: "Search by email or details",
            filters: filters,
            columns: listColumns,
            rowMapper: (document) => OrganizationMemberListBuilder.#mapRow(document, orderedAttributeKeys),
            defaultSort: { field: "addedAt", direction: -1 },
            sortableFields: ["email", "addedAt"],
            rowIdField: "id"
        });

        return {
            definition: definition,
            attributeKeys: orderedAttributeKeys,
            memberColumns: columns
        };
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

    static #buildAttributeFilter(attributeKey, valueType, label)
    {
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
