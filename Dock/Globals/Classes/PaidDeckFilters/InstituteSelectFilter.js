const PaidDeckFilter = require("./PaidDeckFilter");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { paidDeckFilterTypes } = require("../../Enumerations/PaidDeckFilterTypes");

/**
 * InstituteSelectFilter
 *
 * Multi-select filter scoped to the optional `additionalData.institute`
 * sub-document a paid deck may carry. Universal decks (no institute set)
 * simply don't surface here and pass through when the filter is empty.
 *
 * getMetadata() aggregates the distinct institutes attached to published
 * decks so the client renders a searchable dropdown with the live list
 * (no separate `institutes` collection — the source of truth is whatever
 * admins typed into the upload form). Each institute carries its
 * canonical name, location, and alternate-name array so the client can
 * match a query like "BIT" against alternates that aren't in the
 * rendered label.
 *
 * toMongoQuery() filters by canonical name via $in so the same query
 * surface works whether the user picks one institute or several.
 */
class InstituteSelectFilter extends PaidDeckFilter
{
    static #INSTITUTE_NAME_PATH = "additionalData.institute.name";
    static #INSTITUTE_LOCATION_PATH = "additionalData.institute.location";
    static #INSTITUTE_ALTERNATE_NAMES_PATH = "additionalData.institute.alternateNames";

    constructor({ key, label })
    {
        super({ key: key, label: label, type: paidDeckFilterTypes.INSTITUTE_SELECT });
    }

    async #fetchInstitutes(database)
    {
        if (!database)
        {
            return [];
        }

        const collection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);

        const pipeline =
        [
            {
                $match:
                {
                    isPublished: true,
                    [InstituteSelectFilter.#INSTITUTE_NAME_PATH]: { $type: "string", $ne: "" }
                }
            },
            {
                $group:
                {
                    _id: `$${InstituteSelectFilter.#INSTITUTE_NAME_PATH}`,
                    name: { $first: `$${InstituteSelectFilter.#INSTITUTE_NAME_PATH}` },
                    location: { $first: `$${InstituteSelectFilter.#INSTITUTE_LOCATION_PATH}` },
                    alternateNames: { $first: `$${InstituteSelectFilter.#INSTITUTE_ALTERNATE_NAMES_PATH}` }
                }
            },
            {
                $sort: { name: 1 }
            }
        ];

        const aggregatedDocuments = await collection.aggregate(pipeline).toArray();

        return aggregatedDocuments.map(documentEntry =>
        {
            return {
                name: typeof documentEntry.name === "string" ? documentEntry.name : "",
                location: typeof documentEntry.location === "string" ? documentEntry.location : "",
                alternateNames: Array.isArray(documentEntry.alternateNames) ? documentEntry.alternateNames.filter(item => typeof item === "string") : []
            };
        });
    }

    async getMetadata(database)
    {
        const baseMetadata = await super.getMetadata(database);
        const institutes = await this.#fetchInstitutes(database);

        return {
            ...baseMetadata,
            institutes: institutes
        };
    }

    isValueEmpty(value)
    {
        return !Array.isArray(value) || value.length === 0;
    }

    toMongoQuery(value)
    {
        if (this.isValueEmpty(value))
        {
            return null;
        }

        const sanitizedNames = value.filter(rawName => typeof rawName === "string" && rawName.length > 0);
        if (sanitizedNames.length === 0)
        {
            return null;
        }

        const queryFragment = {};
        queryFragment[InstituteSelectFilter.#INSTITUTE_NAME_PATH] = { $in: sanitizedNames };
        return queryFragment;
    }
}

module.exports = InstituteSelectFilter;
