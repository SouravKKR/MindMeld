import Deck from "../../Model/Deck.js";

/**
 * DeckOrphanResolver
 *
 * Shared fallback for a deck whose parent cannot be resolved — whether the
 * gap is a withheld paid deck the account has no license for, a genuinely
 * missing/deleted record, or a dangling local parent reference. Every
 * caller reparents the deck onto the current root instead of treating the
 * gap as a deletion: absence of a resolvable parent is never proof the
 * deck itself should be destroyed.
 */
class DeckOrphanResolver
{
    /**
     * Reattaches an already-instantiated local Deck onto the current root.
     * Used on the sync push side, where the deck object already exists
     * locally and its stored parent id no longer resolves in the id map.
     * @param {Deck} deck
     */
    static reparentLocalOrphanToRoot(deck)
    {
        const rootDeck = Deck.getRoot();

        if (!rootDeck || deck === rootDeck)
        {
            console.warn(`[DeckOrphanResolver] cannot reparent deck "${deck.getName?.()}" (${deck.getId()}) — no root deck available.`);
            return;
        }

        console.warn(`[DeckOrphanResolver] local deck "${deck.getName?.()}" (${deck.getId()}) has no resolvable parent — reparenting to root instead of deleting.`);
        deck.setParent(rootDeck);
        rootDeck.addSubDeck(deck);
    }

    /**
     * Applies each still-unresolved incoming deck-data record by rewriting
     * its parent to the current root's id before handing it to the
     * caller's normal apply routine. Used on the sync pull side so a
     * parent that was never delivered this cycle never becomes an
     * inferred deletion.
     * @param {object[]} unresolvedDeckDataArray
     * @param {(deckData: object, dirtyDeckIds: Set) => void} applyDeckChangeCallback
     * @param {Set} dirtyDeckIds
     */
    static attachUnresolvedDecksToRoot(unresolvedDeckDataArray, applyDeckChangeCallback, dirtyDeckIds)
    {
        const rootDeck = Deck.getRoot();

        if (!rootDeck)
        {
            console.warn(`[DeckOrphanResolver] cannot attach ${unresolvedDeckDataArray.length} unresolved deck(s) — no root deck available.`);
            return;
        }

        for (let index = 0; index < unresolvedDeckDataArray.length; index++)
        {
            const originalDeckData = unresolvedDeckDataArray[index];
            console.warn(`[DeckOrphanResolver] deck "${originalDeckData.name}" (${originalDeckData.id}) — parent ${originalDeckData.parent} not delivered; attaching to root instead of deleting.`);
            applyDeckChangeCallback({ ...originalDeckData, parent: rootDeck.getId() }, dirtyDeckIds);
        }
    }
}

export default DeckOrphanResolver;
