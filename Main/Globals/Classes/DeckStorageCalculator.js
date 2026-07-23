import { serialize } from "../../ThirdParty/Bson/bson.js";

/**
 * DeckStorageCalculator
 *
 * Estimates the stored byte footprint of a deck and its subtree entirely from
 * the in-memory model, so the storage-manager tree can show a size per deck and
 * per subdeck with no server round trip.
 *
 * It mirrors how the server measures the DECKS storage category
 * (StorageQuotaEnforcer.#computeDecksBytes): the sum of each entity's own BSON
 * document size across the separate deck / card / study-material / mock-test
 * collections — NOT the size of one deck JSON with its children embedded. So
 * per-node sizes are computed non-recursively and summed over the subtree.
 *
 * This is a client-side ESTIMATE: it excludes the _id / userId fields the server
 * adds per document, and it counts the deck node via toSyncJson() (the shape
 * that actually syncs). Curated entities are included so the number tracks the
 * server's all-documents total rather than the study-only view. Uploaded files
 * (the UPLOADS category) are not deck content and are never counted here.
 */
class DeckStorageCalculator
{
    // Serialized size of one plain JSON object as a BSON document, in bytes.
    // A serialization failure for one entity must not break the whole tree, so
    // it is treated as contributing zero rather than throwing.
    static #serializedByteLength(jsonObject)
    {
        try
        {
            const serialized = serialize(jsonObject);
            return serialized.byteLength ?? serialized.length ?? 0;
        }
        catch (serializationError)
        {
            console.warn("[DeckStorageCalculator] Failed to size an entity:", serializationError);
            return 0;
        }
    }

    /**
     * The byte footprint of a single deck node plus the entities it directly
     * owns (its own cards, study materials and mock tests) — NOT its subdecks.
     * @param {Deck} deck
     * @returns {number}
     */
    static getOwnBytes(deck)
    {
        if (!deck)
        {
            return 0;
        }

        let totalBytes = DeckStorageCalculator.#serializedByteLength(deck.toSyncJson());

        for (const card of deck.getCards(false, true))
        {
            totalBytes += DeckStorageCalculator.#serializedByteLength(card.toJson());
        }

        for (const studyMaterial of deck.getStudyMaterials(false, true))
        {
            totalBytes += DeckStorageCalculator.#serializedByteLength(studyMaterial.toJson());
        }

        for (const mockTest of deck.getMockTests(false))
        {
            totalBytes += DeckStorageCalculator.#serializedByteLength(mockTest.toJson());
        }

        return totalBytes;
    }

    /**
     * The byte footprint of a deck and its entire subtree — the deck's own
     * bytes plus, recursively, every descendant deck's own bytes. This is the
     * "how much does this deck cost me" number shown on a tree row.
     * @param {Deck} deck
     * @returns {number}
     */
    static getSubtreeBytes(deck)
    {
        if (!deck)
        {
            return 0;
        }

        let totalBytes = DeckStorageCalculator.getOwnBytes(deck);

        for (const subDeck of deck.getSubDecks())
        {
            totalBytes += DeckStorageCalculator.getSubtreeBytes(subDeck);
        }

        return totalBytes;
    }
}

export default DeckStorageCalculator;
