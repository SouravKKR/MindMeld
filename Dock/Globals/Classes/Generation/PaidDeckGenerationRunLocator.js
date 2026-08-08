const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");

/**
 * PaidDeckGenerationRunLocator
 *
 * Answers one question: which paid-deck generation run produced the content in
 * this deck?
 *
 * Why a search rather than a field read. A run stamps
 * `additionalData.paidDeckGeneration` onto the decks it produces, and provenance
 * is filed against the top-level one. But the deck an administrator picks in the
 * upload dialog is whichever node of that tree they intend to sell, and that is
 * routinely NOT the node the record is filed under:
 *
 *   Chemistry                      <- launch deck; the tile the admin sees and picks
 *     Unit I: Fundamentals ...     <- what the run produced; the record is filed here
 *       Chemical Foundations       <- a sub-deck that may be sold on its own
 *
 * Picking any of those three is legitimate, so a listing id that resolved only to
 * an exact match left the audit trail 404'ing and — far worse — left
 * PaidDeckPublishGate finding no record and therefore allowing the publish. A
 * deck whose verification never ran shipped to buyers with the review gate
 * reporting success, which is the "control that is not a control in fact" this
 * pipeline's own comments warn about.
 *
 * Resolution order, and why it is that order:
 *
 *   1. The deck's own marker. An exact statement about this deck; nothing beats it.
 *   2. Descendants. A marker below you is content you contain, so the run that
 *      produced it produced part of what is being sold.
 *   3. Ancestors. A marker above you means you are a fragment of that run's output
 *      — true for a sub-deck sold individually, but a weaker claim than either of
 *      the above, so it is consulted last.
 *
 * Ambiguity is refused rather than guessed. When the descendants below one deck
 * carry markers from two different runs, no single record governs the listing;
 * returning either would attach one run's evidence to another run's content, and
 * a mis-attributed audit trail is worse than a missing one.
 *
 * The launch deck is deliberately NOT stamped at generation time. It is a deck
 * the user already owned, so writing to it would bump its lifecycle.lastModified
 * and race a newer edit sitting unsynced on a device — and step 2 above locates
 * it anyway.
 */
class PaidDeckGenerationRunLocator
{
    static ROOT_DECK_ID = "0";

    /**
     * Depth guard for both walks. Real syllabus trees are three or four levels;
     * this only exists so a corrupted parent chain (a deck that is its own
     * ancestor) terminates instead of spinning.
     */
    static MAXIMUM_TREE_DEPTH = 12;

    /**
     * Locates the generation run behind a deck.
     *
     * @param {string} deckId
     * @returns {Promise<string>} The run's mainTaskId, or "" when no single run governs the deck.
     */
    static async findMainTaskId(deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0 || deckId === PaidDeckGenerationRunLocator.ROOT_DECK_ID)
        {
            return "";
        }

        const deckCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const deckDocument = await deckCollection.findOne(
            { "data.id": deckId },
            { projection: { _id: 0, userId: 1, "data.id": 1, "data.parent": 1, "data.additionalData.paidDeckGeneration": 1 } },
        );

        if (!deckDocument)
        {
            return "";
        }

        const ownMainTaskId = PaidDeckGenerationRunLocator.#readMainTaskId(deckDocument);
        if (ownMainTaskId.length > 0)
        {
            return ownMainTaskId;
        }

        // Scoped to the owning user for both walks: deck ids are unique in
        // practice, but a tree walk that could cross into another user's library
        // would be a data-leak shape regardless of how unlikely the collision is.
        const userId = deckDocument.userId;

        const descendantMainTaskId = await PaidDeckGenerationRunLocator.#findInDescendants(deckCollection, userId, deckId);
        if (descendantMainTaskId.length > 0)
        {
            return descendantMainTaskId;
        }

        return await PaidDeckGenerationRunLocator.#findInAncestors(deckCollection, userId, deckDocument.data?.parent);
    }

    /**
     * Breadth-first over the subtree, stopping the descent at each marked deck —
     * everything below a marked deck belongs to the same run, so descending
     * further only adds reads.
     *
     * Returns "" when two different runs are found, which is a real answer: the
     * caller must then treat the deck as having no governing record.
     */
    static async #findInDescendants(deckCollection, userId, rootDeckId)
    {
        const foundMainTaskIds = new Set();
        let frontierDeckIds = [rootDeckId];

        for (let depth = 0; depth < PaidDeckGenerationRunLocator.MAXIMUM_TREE_DEPTH && frontierDeckIds.length > 0; depth++)
        {
            const childDocuments = await deckCollection.find(
                { userId: userId, "data.parent": { $in: frontierDeckIds } },
                { projection: { _id: 0, "data.id": 1, "data.additionalData.paidDeckGeneration": 1 } },
            ).toArray();

            const nextFrontierDeckIds = [];

            for (const childDocument of childDocuments)
            {
                const childMainTaskId = PaidDeckGenerationRunLocator.#readMainTaskId(childDocument);

                if (childMainTaskId.length > 0)
                {
                    foundMainTaskIds.add(childMainTaskId);
                    continue;
                }

                if (typeof childDocument.data?.id === "string" && childDocument.data.id.length > 0)
                {
                    nextFrontierDeckIds.push(childDocument.data.id);
                }
            }

            frontierDeckIds = nextFrontierDeckIds;
        }

        if (foundMainTaskIds.size === 1)
        {
            return Array.from(foundMainTaskIds)[0];
        }

        if (foundMainTaskIds.size > 1)
        {
            console.warn(
                `[PaidDeckGenerationRunLocator] Deck ${rootDeckId} contains content from ${foundMainTaskIds.size} different `
                + "generation runs — no single provenance record governs it.",
            );
        }

        return "";
    }

    /**
     * Walks up the parent chain. The first marker found wins: it is the closest
     * run that produced an ancestor of this deck, and any run further up produced
     * that one in turn.
     */
    static async #findInAncestors(deckCollection, userId, startingParentDeckId)
    {
        let currentDeckId = startingParentDeckId;

        for (let depth = 0; depth < PaidDeckGenerationRunLocator.MAXIMUM_TREE_DEPTH; depth++)
        {
            if (typeof currentDeckId !== "string" || currentDeckId.length === 0 || currentDeckId === PaidDeckGenerationRunLocator.ROOT_DECK_ID)
            {
                return "";
            }

            const ancestorDocument = await deckCollection.findOne(
                { userId: userId, "data.id": currentDeckId },
                { projection: { _id: 0, "data.parent": 1, "data.additionalData.paidDeckGeneration": 1 } },
            );

            if (!ancestorDocument)
            {
                return "";
            }

            const ancestorMainTaskId = PaidDeckGenerationRunLocator.#readMainTaskId(ancestorDocument);
            if (ancestorMainTaskId.length > 0)
            {
                return ancestorMainTaskId;
            }

            currentDeckId = ancestorDocument.data?.parent;
        }

        return "";
    }

    static #readMainTaskId(deckDocument)
    {
        const mainTaskId = deckDocument?.data?.additionalData?.paidDeckGeneration?.mainTaskId;
        return typeof mainTaskId === "string" ? mainTaskId : "";
    }
}

module.exports = PaidDeckGenerationRunLocator;
