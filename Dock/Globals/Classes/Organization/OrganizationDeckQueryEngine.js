const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const PaidDeck = require("../../Model/PaidDeck");
const { deckLicenseStatuses } = require("../../Enumerations/DeckLicenseStatuses");

/**
 * OrganizationDeckQueryEngine
 *
 * Reads over the decks an organization publishes to its own members.
 *
 * They live in the same `paidDecks` collection as the catalogue, distinguished
 * only by `audienceOrganizationId`. That is deliberate: an organization's deck
 * IS a paid deck in every respect that matters — encrypted at rest, encrypted
 * on the sync wire, immutable on push, export-blocked — and giving it a second
 * collection would mean a second copy of all of that, drifting quietly from the
 * first. The only differences are who may see it and that it is free, and both
 * are fields rather than storage decisions.
 */
class OrganizationDeckQueryEngine
{
    static async #getDeckCollection()
    {
        const database = await DatabaseConnector.getDatabase();
        return database ? database.collection(DatabaseConstants.PAID_DECKS_COLLECTION) : null;
    }

    /**
     * Every deck this organization publishes, newest first, drafts included —
     * this is the administrator's own list, so an unpublished deck they are
     * still preparing has to appear.
     *
     * @param {string} organizationId
     * @returns {Promise<Array<PaidDeck>>}
     */
    static async listDecksForOrganization(organizationId)
    {
        const collection = await OrganizationDeckQueryEngine.#getDeckCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const documents = await collection
            .find({ audienceOrganizationId: organizationId }, { projection: { _id: 0 } })
            .sort({ publishedAt: -1 })
            .toArray();

        return documents.map(document => PaidDeck.fromJson(document));
    }

    /**
     * The published decks a member may add, optionally narrowed to the ones
     * their tags were targeted with.
     *
     * Targeting is a DEFAULT FILTER, never an access rule — a member who asks
     * for everything gets everything the organization published, and may add
     * any of it. An institute that needs a deck kept from some of its people
     * publishes it to a different audience instead. Treating the filter as a
     * control would make the shelf's own "show everything" toggle a way around
     * it, which is the worst kind of access rule: one that looks like it works.
     *
     * @param {string} organizationId
     * @param {string[]} memberTags
     * @param {boolean} bIncludeUntargeted true to ignore targeting entirely
     * @returns {Promise<Array<PaidDeck>>}
     */
    static async listShelfForMember(organizationId, memberTags, bIncludeUntargeted)
    {
        const collection = await OrganizationDeckQueryEngine.#getDeckCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return [];
        }

        const query = { audienceOrganizationId: organizationId, isPublished: true };

        if (!bIncludeUntargeted)
        {
            const normalisedTags = Array.isArray(memberTags)
                ? memberTags.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag.length > 0)
                : [];

            // An empty audienceTags means "everyone in the organization", so it
            // has to match even for a member holding no tags at all.
            query.$or =
            [
                { audienceTags: { $size: 0 } },
                { audienceTags: { $exists: false } },
                { audienceTags: { $in: normalisedTags } }
            ];
        }

        const documents = await collection
            .find(query, { projection: { _id: 0 } })
            .sort({ publishedAt: -1 })
            .toArray();

        return documents.map(document => PaidDeck.fromJson(document));
    }

    /**
     * How many decks this organization currently PUBLISHES. Drafts are excluded
     * on purpose: the cap the super-admin sets bounds what an institute puts in
     * front of its members, not how many it is drafting.
     *
     * @param {string} organizationId
     * @returns {Promise<number>}
     */
    static async countPublishedDecks(organizationId)
    {
        const collection = await OrganizationDeckQueryEngine.#getDeckCollection();
        if (!collection || typeof organizationId !== "string" || organizationId.length === 0)
        {
            return 0;
        }

        return collection.countDocuments({ audienceOrganizationId: organizationId, isPublished: true });
    }

    /**
     * One of this organization's decks, by id. Returns null when the deck
     * belongs to somebody else — the ownership test is part of the LOOKUP, so a
     * caller cannot forget to apply it after loading.
     *
     * @param {string} organizationId
     * @param {string} deckId
     * @returns {Promise<PaidDeck|null>}
     */
    static async getOrganizationDeck(organizationId, deckId)
    {
        const collection = await OrganizationDeckQueryEngine.#getDeckCollection();
        if (!collection || typeof deckId !== "string" || deckId.length === 0)
        {
            return null;
        }

        const document = await collection.findOne({ id: deckId, audienceOrganizationId: organizationId }, { projection: { _id: 0 } });
        return document ? PaidDeck.fromJson(document) : null;
    }

    /**
     * Every account currently holding an active licence for a deck. Used by the
     * withdrawal path, which has to reach each of them individually because
     * their copies live in per-member scopes.
     *
     * @param {string} deckId
     * @returns {Promise<Array<object>>} raw licence documents
     */
    static async listActiveLicenseDocuments(deckId)
    {
        const database = await DatabaseConnector.getDatabase();
        if (!database || typeof deckId !== "string" || deckId.length === 0)
        {
            return [];
        }

        return database
            .collection(DatabaseConstants.DECK_LICENSES_COLLECTION)
            .find({ deckId: deckId, status: deckLicenseStatuses.ACTIVE })
            .toArray();
    }
}

module.exports = OrganizationDeckQueryEngine;
