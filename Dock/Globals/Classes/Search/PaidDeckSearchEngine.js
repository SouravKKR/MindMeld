const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PaidDeckFilterRegistry = require("../PaidDeckFilters/PaidDeckFilterRegistry");
const PaidDeckPricingEngine = require("../Pricing/PaidDeckPricingEngine");
const { paidDeckSortFields } = require("../../Enumerations/PaidDeckSortFields");
const { sortDirections } = require("../../Enumerations/SortDirections");

/**
 * PaidDeckSearchEngine
 *
 * Composes the live filter registry into a single MongoDB query, runs
 * the find, then enriches each result with the buyer-specific computed
 * price. The actual filtering work happens in Mongo (the only thing
 * this engine does on the Node side is iterate the registry and $and
 * the fragments together). When the user changes filters / search /
 * sort, exactly one round-trip to Mongo is made.
 */
class PaidDeckSearchEngine
{
    static #DEFAULT_LIMIT = 50;
    static #MAX_LIMIT = 200;

    static #SORT_FIELD_TO_DB_FIELD = new Map
    ([
        [paidDeckSortFields.PUBLISHED_AT,     "publishedAt"],
        [paidDeckSortFields.TITLE,            "title"],
        [paidDeckSortFields.BASE_PRICE_MINOR, "basePriceMinor"],
        [paidDeckSortFields.CATEGORY,         "category"]
    ]);

    static async listFilterMetadata()
    {
        const database = await DatabaseConnector.getDatabase();
        return await PaidDeckFilterRegistry.getMetadataList(database);
    }

    static #buildSortClause(sortRequest)
    {
        const requestedField = sortRequest?.field;
        const requestedDirection = sortRequest?.direction;

        const fieldName = PaidDeckSearchEngine.#SORT_FIELD_TO_DB_FIELD.get(requestedField)
            ?? "publishedAt";

        const direction = requestedDirection === sortDirections.ASCENDING ? 1 : -1;

        return { [fieldName]: direction };
    }

    static #buildMongoQueryFromFilters(filterValuesByKey)
    {
        const queryParts = [];

        for (const filter of PaidDeckFilterRegistry.getAll())
        {
            const submittedValue = filterValuesByKey?.[filter.getKey()];

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

        return queryParts;
    }

    static async search({ filters, sort, region, limit, offset, userId, includeUnpublished })
    {
        const database = await DatabaseConnector.getDatabase();
        const decksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

        const filterFragments = PaidDeckSearchEngine.#buildMongoQueryFromFilters(filters);

        // Restrict the public catalogue to published decks; the admin
        // panel passes includeUnpublished=true so it can see drafts.
        const baseQueryParts = includeUnpublished ? [] : [{ isPublished: true }];
        const allQueryParts = [...baseQueryParts, ...filterFragments];

        const mongoQuery = allQueryParts.length === 0 ? {} : { $and: allQueryParts };
        const sortClause = PaidDeckSearchEngine.#buildSortClause(sort);

        const effectiveLimit = Math.min(Math.max(Number(limit) || PaidDeckSearchEngine.#DEFAULT_LIMIT, 1), PaidDeckSearchEngine.#MAX_LIMIT);
        const effectiveOffset = Math.max(Number(offset) || 0, 0);

        const totalMatchingCount = await decksCollection.countDocuments(mongoQuery);

        const deckDocuments = await decksCollection
            .find(mongoQuery)
            .sort(sortClause)
            .skip(effectiveOffset)
            .limit(effectiveLimit)
            .toArray();

        const effectiveRegion = (region || "GLOBAL").toUpperCase();
        const enrichedDecks = [];

        for (const deckDocument of deckDocuments)
        {
            delete deckDocument._id;

            const pricingBreakdown = await PaidDeckPricingEngine.computeFinalPrice
            (
                userId,
                [deckDocument.id],
                effectiveRegion
            );

            enrichedDecks.push
            ({
                ...deckDocument,
                computedPrice: pricingBreakdown.breakdown[0] || null,
                currency: pricingBreakdown.currency
            });
        }

        return {
            decks: enrichedDecks,
            totalCount: totalMatchingCount,
            offset: effectiveOffset,
            limit: effectiveLimit,
            region: effectiveRegion
        };
    }
}

module.exports = PaidDeckSearchEngine;
