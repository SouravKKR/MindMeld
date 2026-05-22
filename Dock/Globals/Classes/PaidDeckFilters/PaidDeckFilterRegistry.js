const TextSearchFilter = require("./TextSearchFilter");
const NumberRangeFilter = require("./NumberRangeFilter");
const DateRangeFilter = require("./DateRangeFilter");
const MultiSelectFilter = require("./MultiSelectFilter");
const EnumFilter = require("./EnumFilter");
const BooleanFilter = require("./BooleanFilter");
const InstituteSelectFilter = require("./InstituteSelectFilter");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { deckPurchaseGranularity } = require("../../Enumerations/DeckPurchaseGranularity");

/**
 * PaidDeckFilterRegistry
 *
 * Holds the live set of filter instances the paid-deck search system
 * exposes. To add a new filter:
 *   1. Either reuse one of the existing filter classes with new config
 *      (TextSearch / NumberRange / DateRange / MultiSelect / Enum /
 *      Boolean) or write a new subclass of PaidDeckFilter that outputs
 *      its own Mongo query fragment.
 *   2. Add one call to `PaidDeckFilterRegistry.register(new Whatever({...}))`
 *      in the static block below.
 *
 * Removing a filter is a single line. Updating one is a config edit.
 * Nothing in the search engine or the client UI needs to change — the
 * client renders inputs purely from getMetadata() output.
 *
 * Filters are keyed for O(1) lookup; insertion order is preserved so
 * the UI renders them in the order they were registered.
 */
class PaidDeckFilterRegistry
{
    static #filtersByKey = new Map();

    static
    {
        // Free-text search across the four most-useful card-facing fields.
        PaidDeckFilterRegistry.register(new TextSearchFilter
        ({
            key: "query",
            label: "Search",
            fields: ["title", "description", "category", "tags"]
        }));

        // Price: range in minor units. Step of 100 means "1 rupee per
        // tick" for INR pricing, "1 cent per tick" for USD — the UI
        // honours the configured step via its slider input.
        PaidDeckFilterRegistry.register(new NumberRangeFilter
        ({
            key: "price",
            label: "Price",
            field: "basePriceMinor",
            defaultMin: 0,
            defaultMax: 1000000,
            step: 100
        }));

        // Upload date — clients send ISO-8601 strings.
        PaidDeckFilterRegistry.register(new DateRangeFilter
        ({
            key: "uploadDate",
            label: "Upload date",
            field: "publishedAt"
        }));

        // Category: dynamic options — distinct categories discovered
        // from the published-decks collection at metadata-fetch time, so
        // admin-uploaded categories appear automatically without a Dock
        // restart.
        PaidDeckFilterRegistry.register(new MultiSelectFilter
        ({
            key: "category",
            label: "Category",
            field: "category",
            dynamicSource:
            {
                collection: DatabaseConstants.PAID_DECKS_COLLECTION,
                field: "category",
                baseFilter: { isPublished: true }
            }
        }));

        // Tags: same dynamic-discovery pattern but on the tags array.
        PaidDeckFilterRegistry.register(new MultiSelectFilter
        ({
            key: "tags",
            label: "Tags",
            field: "tags",
            dynamicSource:
            {
                collection: DatabaseConstants.PAID_DECKS_COLLECTION,
                field: "tags",
                baseFilter: { isPublished: true }
            }
        }));

        // Institute (optional) — looks at additionalData.institute.* on
        // each published deck. Universal (institute-less) decks simply
        // don't appear here and are unaffected unless the filter is set.
        PaidDeckFilterRegistry.register(new InstituteSelectFilter
        ({
            key: "institute",
            label: "Institute"
        }));

        // Granularity — single-choice enum.
        PaidDeckFilterRegistry.register(new EnumFilter
        ({
            key: "granularity",
            label: "Purchase granularity",
            field: "granularity",
            options:
            [
                { value: deckPurchaseGranularity.INDIVIDUAL, label: "Individually buyable" },
                { value: deckPurchaseGranularity.BUNDLE_ONLY, label: "Bundle only" }
            ]
        }));

        // "Is this a bundle?" boolean — derived in Mongo by checking
        // whether bundleChildIds has elements. Mongo treats arrays as
        // having "elements" via the $ne [] form, but for a clean filter
        // value (true/false) we use a custom subclass would be overkill;
        // instead expose this as a BooleanFilter on a denormalised
        // flag if/when needed. For now skip — admin can add it later
        // with one line: register(new BooleanFilter({...})).
    }

    static register(filter)
    {
        PaidDeckFilterRegistry.#filtersByKey.set(filter.getKey(), filter);
    }

    static unregister(filterKey)
    {
        PaidDeckFilterRegistry.#filtersByKey.delete(filterKey);
    }

    static getByKey(filterKey)
    {
        return PaidDeckFilterRegistry.#filtersByKey.get(filterKey) || null;
    }

    static getAll()
    {
        return Array.from(PaidDeckFilterRegistry.#filtersByKey.values());
    }

    static async getMetadataList(database)
    {
        const metadataList = [];

        for (const filter of PaidDeckFilterRegistry.getAll())
        {
            metadataList.push(await filter.getMetadata(database));
        }

        return metadataList;
    }
}

module.exports = PaidDeckFilterRegistry;
