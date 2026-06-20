/**
 * AdminListDefinition
 *
 * Declares one admin-panel list so the generic AdminListQueryRunner can serve
 * it (search + filter + sort + paginate) and the client can render it without
 * any list-specific server code. There are two backing modes:
 *
 *   - Collection-backed: set `collectionName`, `searchableFields`, `filters`,
 *     and `rowMapper`. The query runner builds a Mongo query, counts, and
 *     returns a mapped page.
 *
 *   - Custom: set `customQueryBuilder(database, parameters)` returning
 *     { items, totalCount } for lists that need aggregation or a cross-
 *     collection join (revenue, organizations, org members, promo codes).
 *
 * `columns` drives both the client table header and the row-cell lookups; each
 * column key must exist on the object returned by `rowMapper` / the custom
 * builder. `sortableFields` whitelists the DB field names a client may sort by
 * (anything else falls back to `defaultSort`), so a client cannot sort on an
 * arbitrary unindexed field.
 */
class AdminListDefinition
{
    static DEFAULT_LIMIT = 50;
    static MAX_LIMIT = 200;
    static DEFAULT_LIMIT_OPTIONS = [25, 50, 100, 200];

    #listKey;
    #collectionName;
    #customQueryBuilder;
    #searchableFields;
    #searchPlaceholder;
    #filters;
    #columns;
    #rowMapper;
    #defaultSort;
    #sortableFields;
    #defaultLimit;
    #limitOptions;
    #rowIdField;

    constructor({ listKey, collectionName = null, customQueryBuilder = null, searchableFields = [], searchPlaceholder = "Search…", filters = [], columns = [], rowMapper = null, defaultSort = null, sortableFields = [], defaultLimit = AdminListDefinition.DEFAULT_LIMIT, limitOptions = AdminListDefinition.DEFAULT_LIMIT_OPTIONS, rowIdField = "id" } = {})
    {
        if (listKey === undefined || listKey === null)
        {
            throw new Error("AdminListDefinition requires a listKey");
        }

        if (!collectionName && typeof customQueryBuilder !== "function")
        {
            throw new Error("AdminListDefinition requires either a collectionName or a customQueryBuilder");
        }

        this.#listKey = listKey;
        this.#collectionName = collectionName;
        this.#customQueryBuilder = customQueryBuilder;
        this.#searchableFields = Array.isArray(searchableFields) ? searchableFields : [];
        this.#searchPlaceholder = searchPlaceholder;
        this.#filters = Array.isArray(filters) ? filters : [];
        this.#columns = Array.isArray(columns) ? columns : [];
        this.#rowMapper = typeof rowMapper === "function" ? rowMapper : (document => document);
        this.#defaultSort = defaultSort;
        this.#sortableFields = Array.isArray(sortableFields) ? sortableFields : [];
        this.#defaultLimit = defaultLimit;
        this.#limitOptions = Array.isArray(limitOptions) ? limitOptions : AdminListDefinition.DEFAULT_LIMIT_OPTIONS;
        this.#rowIdField = rowIdField;
    }

    getListKey()
    {
        return this.#listKey;
    }

    getCollectionName()
    {
        return this.#collectionName;
    }

    getCustomQueryBuilder()
    {
        return this.#customQueryBuilder;
    }

    isCustom()
    {
        return typeof this.#customQueryBuilder === "function";
    }

    getSearchableFields()
    {
        return this.#searchableFields;
    }

    getSearchPlaceholder()
    {
        return this.#searchPlaceholder;
    }

    getFilters()
    {
        return this.#filters;
    }

    getColumns()
    {
        return this.#columns;
    }

    getRowMapper()
    {
        return this.#rowMapper;
    }

    getDefaultSort()
    {
        return this.#defaultSort;
    }

    getSortableFields()
    {
        return this.#sortableFields;
    }

    getDefaultLimit()
    {
        return this.#defaultLimit;
    }

    getLimitOptions()
    {
        return this.#limitOptions;
    }

    getRowIdField()
    {
        return this.#rowIdField;
    }

    /**
     * Resolves a client-requested sort into a { field, direction } pair, only
     * honouring fields explicitly whitelisted in sortableFields.
     */
    resolveSort(requestedSort)
    {
        const fallback = this.#defaultSort || { field: null, direction: -1 };

        const requestedField = requestedSort?.field;
        if (typeof requestedField === "string" && this.#sortableFields.includes(requestedField))
        {
            const requestedDirection = Number(requestedSort?.direction) === 1 ? 1 : -1;
            return { field: requestedField, direction: requestedDirection };
        }

        return { field: fallback.field, direction: Number(fallback.direction) === 1 ? 1 : -1 };
    }

    clampLimit(requestedLimit)
    {
        const numericLimit = Number(requestedLimit) || this.#defaultLimit;
        return Math.min(Math.max(numericLimit, 1), AdminListDefinition.MAX_LIMIT);
    }

    clampOffset(requestedOffset)
    {
        return Math.max(Number(requestedOffset) || 0, 0);
    }

    async getMetadata(database)
    {
        const filterMetadata = [];
        for (const filter of this.#filters)
        {
            filterMetadata.push(await filter.getMetadata(database));
        }

        return {
            listKey: this.#listKey,
            searchEnabled: this.#searchableFields.length > 0,
            searchPlaceholder: this.#searchPlaceholder,
            filters: filterMetadata,
            columns: this.#columns,
            defaultSort: this.#defaultSort,
            sortableFields: this.#sortableFields,
            defaultLimit: this.#defaultLimit,
            limitOptions: this.#limitOptions,
            rowIdField: this.#rowIdField
        };
    }
}

module.exports = AdminListDefinition;
