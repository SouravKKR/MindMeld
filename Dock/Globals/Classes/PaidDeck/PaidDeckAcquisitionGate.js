const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * PaidDeckAcquisitionGate
 *
 * Whether a deck may be ACQUIRED right now — bought, granted by a coupon,
 * claimed as a plan perk, or auto-assigned by an organization's perk.
 *
 * Separate from whether it may be SEEN. Visibility answers "should this appear
 * in a catalogue"; this answers "may a new licence be issued". The two came
 * apart the moment retirement existed: a retired deck is invisible AND
 * unacquirable, but a draft is invisible while still perfectly acquirable by
 * the admin testing it, and an existing holder of a retired deck keeps using it
 * — nothing here touches a licence that already exists.
 *
 * It also closes a hole that predates retirement. Nothing in the checkout ever
 * checked `isPublished`: the storefront simply did not list a draft, so buying
 * one meant knowing its id. Withdrawing a deck from sale has to actually stop
 * sales, so the check belongs somewhere every acquisition path passes through
 * rather than in the one path somebody remembers.
 *
 * Retirement is deliberately one-way. A deck comes back by being uploaded
 * again, not by being un-retired: buyers were told it was withdrawn, and a
 * listing that can silently return is a promise the operator did not make.
 */
class PaidDeckAcquisitionGate
{
    /**
     * True when the stored deck has been retired.
     *
     * `retiredAt` holds the FOREVER sentinel (epoch zero) while a deck is on
     * sale, matching how DeckLicense expresses "no expiry" — a null would have
     * to be special-cased at every read.
     *
     * @param {object} paidDeckDocument
     * @returns {boolean}
     */
    static isRetired(paidDeckDocument)
    {
        if (!paidDeckDocument)
        {
            return false;
        }

        const retiredAt = typeof paidDeckDocument.getRetiredAt === "function"
            ? paidDeckDocument.getRetiredAt()
            : paidDeckDocument.retiredAt;

        if (!retiredAt)
        {
            return false;
        }

        const retiredAtMilliseconds = new Date(retiredAt).getTime();
        return !isNaN(retiredAtMilliseconds) && retiredAtMilliseconds > 0;
    }

    /**
     * Decides one deck, from an already-loaded document.
     *
     * @param {object} paidDeckDocument
     * @returns {{ allowed: boolean, reason?: string }}
     */
    static evaluate(paidDeckDocument)
    {
        if (!paidDeckDocument)
        {
            return { allowed: false, reason: ErrorCodes.PAID_DECK_NOT_FOUND };
        }

        if (PaidDeckAcquisitionGate.isRetired(paidDeckDocument))
        {
            return { allowed: false, reason: ErrorCodes.PAID_DECK_RETIRED };
        }

        const bPublished = typeof paidDeckDocument.getIsPublished === "function"
            ? paidDeckDocument.getIsPublished() === true
            : paidDeckDocument.isPublished === true;

        if (!bPublished)
        {
            return { allowed: false, reason: ErrorCodes.PAID_DECK_NOT_ON_SALE };
        }

        return { allowed: true };
    }

    /**
     * Decides a set of deck ids in one query, for a basket.
     *
     * Returns the ids that may NOT be acquired together with why, rather than
     * the first failure: a buyer with three decks in a basket should be told
     * about all three at once instead of discovering them one refusal at a time.
     *
     * @param {string[]} deckIds
     * @returns {Promise<{ allowed: boolean, refusals: Array<{ deckId: string, reason: string }> }>}
     */
    static async evaluateMany(deckIds)
    {
        const safeDeckIds = Array.isArray(deckIds) ? deckIds.filter(deckId => typeof deckId === "string" && deckId.length > 0) : [];
        if (safeDeckIds.length === 0)
        {
            return { allowed: true, refusals: [] };
        }

        const database = await DatabaseConnector.getDatabase();
        if (!database)
        {
            // Unknown is not permission. A checkout that cannot verify the
            // catalogue must not issue licences on the assumption it is fine.
            return { allowed: false, refusals: safeDeckIds.map(deckId => ({ deckId: deckId, reason: ErrorCodes.PAID_DECK_NOT_FOUND })) };
        }

        const deckDocuments = await database
            .collection(DatabaseConstants.PAID_DECKS_COLLECTION)
            .find({ id: { $in: safeDeckIds } }, { projection: { _id: 0, id: 1, isPublished: 1, retiredAt: 1 } })
            .toArray();

        const documentsById = new Map(deckDocuments.map(document => [document.id, document]));
        const refusals = [];

        for (const deckId of safeDeckIds)
        {
            const decision = PaidDeckAcquisitionGate.evaluate(documentsById.get(deckId) || null);
            if (!decision.allowed)
            {
                refusals.push({ deckId: deckId, reason: decision.reason });
            }
        }

        return { allowed: refusals.length === 0, refusals: refusals };
    }

    /**
     * Decides a single deck id, loading it.
     *
     * @param {string} deckId
     * @returns {Promise<{ allowed: boolean, reason?: string }>}
     */
    static async evaluateById(deckId)
    {
        const result = await PaidDeckAcquisitionGate.evaluateMany([deckId]);
        return result.allowed ? { allowed: true } : { allowed: false, reason: result.refusals[0].reason };
    }
}

module.exports = PaidDeckAcquisitionGate;
