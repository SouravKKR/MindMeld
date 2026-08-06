const TextSearchFilter = require("../PaidDeckFilters/TextSearchFilter");

/**
 * AdminListQueryRunner
 *
 * Executes an AdminListDefinition against MongoDB. For collection-backed
 * definitions it builds a single query by $and-ing the free-text search
 * fragment with each filter's fragment (exactly the PaidDeckSearchEngine
 * pattern), then counts and returns one mapped page. Custom definitions
 * delegate entirely to their customQueryBuilder.
 */
class AdminListQueryRunner
{
    /**
     * @param {AdminListDefinition} definition
     * @param {object} database — Mongo database handle
     * @param {object} parameters — { search, filters, sort, limit, offset, context }
     * @returns {Promise<{items: object[], totalCount: number, limit: number, offset: number}>}
     */
    static async run(definition, database, parameters = {})
    {
        const limit = definition.clampLimit(parameters.limit);
        const offset = definition.clampOffset(parameters.offset);
        const sort = definition.resolveSort(parameters.sort);

        if (definition.isCustom())
        {
            const customResult = await definition.getCustomQueryBuilder()(database,
            {
                search: typeof parameters.search === "string" ? parameters.search : "",
                filters: parameters.filters || {},
                sort: sort,
                limit: limit,
                offset: offset,
                context: parameters.context || {}
            });

            return {
                items: Array.isArray(customResult?.items) ? customResult.items : [],
                totalCount: Number(customResult?.totalCount) || 0,
                limit: limit,
                offset: offset
            };
        }

        const collection = database.collection(definition.getCollectionName());
        const mongoQuery = AdminListQueryRunner.#buildMongoQuery(definition, parameters);

        const totalCount = await collection.countDocuments(mongoQuery);

        const sortClause = sort.field ? { [sort.field]: sort.direction } : {};

        const documents = await collection
            .find(mongoQuery)
            .sort(sortClause)
            .skip(offset)
            .limit(limit)
            .toArray();

        const rowMapper = definition.getRowMapper();
        const items = documents.map(document =>
        {
            delete document._id;
            return rowMapper(document);
        });

        return { items: items, totalCount: totalCount, limit: limit, offset: offset };
    }

    static #buildMongoQuery(definition, parameters)
    {
        const queryParts = [];

        // The definition's own scope first, so it can never be dropped by an
        // absent or malformed client filter.
        const baseQuery = definition.getBaseQuery();
        if (baseQuery)
        {
            queryParts.push(baseQuery);
        }

        // Free-text search across the declared searchable fields, expressed
        // through the same TextSearchFilter the paid-deck search uses.
        const searchableFields = definition.getSearchableFields();
        const searchValue = parameters.search;
        if (searchableFields.length > 0 && typeof searchValue === "string" && searchValue.trim().length > 0)
        {
            const searchFilter = new TextSearchFilter({ key: "search", label: "Search", fields: searchableFields });
            const searchFragment = searchFilter.toMongoQuery(searchValue);
            if (searchFragment)
            {
                queryParts.push(searchFragment);
            }
        }

        const filterValuesByKey = parameters.filters || {};
        for (const filter of definition.getFilters())
        {
            const submittedValue = filterValuesByKey[filter.getKey()];
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

        return queryParts.length === 0 ? {} : { $and: queryParts };
    }
}

module.exports = AdminListQueryRunner;
