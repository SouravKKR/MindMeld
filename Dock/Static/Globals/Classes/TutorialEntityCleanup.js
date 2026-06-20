import Deck from "../Model/Deck.js";
import DeckEvents from "../Events/DeckEvents.js";

/**
 * TutorialEntityCleanup
 *
 * Finds every Deck / Card / StudyMaterial / MockTest whose additionalData
 * carries the tutorial-created flag and deletes it. The flag is written
 * by the editor pages (DeckEditor, CardEditor) when they construct a new
 * entity while TutorialEngine.isRunning() — see those files.
 *
 * Tag-based discovery is more robust than the previous "snapshot at
 * start, diff at end" approach: it survives reloads (the flag is on
 * disk), it doesn't false-positive on unrelated background syncs, and it
 * naturally handles cleanup at "Start over" mid-tutorial as well as at
 * Finish.
 *
 * Caller must pass the flag key string in (so this module doesn't have
 * to import TutorialEngine, breaking a potential cycle).
 */
class TutorialEntityCleanup
{
    /**
     * Deletes every flagged entity. Order:
     *   1. Cards / study materials / mock tests inside non-flagged decks
     *      (so they don't dangle if the deck survives).
     *   2. Flagged non-root decks (cascade handles their contents).
     *
     * Returns a summary { decks, cards, studyMaterials, mockTests }.
     */
    static async clearTutorialCreatedItems(flagKey)
    {
        const summary =
        {
            decks:           0,
            cards:           0,
            studyMaterials:  0,
            mockTests:       0
        };

        if (!flagKey)
        {
            return summary;
        }

        const allDecks = Deck.getAll();

        // ── Phase 1: flagged children inside non-flagged (surviving) decks.
        for (const deck of allDecks)
        {
            if (deck.isRoot())
            {
                // Root never has a flag and never gets deleted; iterate its
                // direct children to find flagged cards/SMs/MTs.
            }

            if (TutorialEntityCleanup.#hasFlag(deck.getAdditionalData(), flagKey))
            {
                // Will be deleted in phase 2; its children cascade with it.
                continue;
            }

            const directCards = deck.getCards(false, true);
            for (const card of directCards)
            {
                if (TutorialEntityCleanup.#hasFlag(card.getAdditionalData?.(), flagKey))
                {
                    await card.delete();
                    summary.cards++;
                }
            }

            const directMaterials = deck.getStudyMaterials(false, true);
            for (const material of directMaterials)
            {
                if (TutorialEntityCleanup.#hasFlag(material.getAdditionalData?.(), flagKey))
                {
                    await material.delete();
                    summary.studyMaterials++;
                }
            }

            const directMockTests = deck.getMockTests ? deck.getMockTests(false) : [];
            for (const mockTest of directMockTests)
            {
                if (TutorialEntityCleanup.#hasFlag(mockTest.getAdditionalData?.(), flagKey))
                {
                    await mockTest.delete();
                    summary.mockTests++;
                }
            }
        }

        // ── Phase 2: flagged non-root decks. Deletion cascades to children.
        const flaggedDecks = Deck.getAll().filter(deck =>
        {
            return !deck.isRoot() && TutorialEntityCleanup.#hasFlag(deck.getAdditionalData(), flagKey);
        });

        for (const flaggedDeck of flaggedDecks)
        {
            await flaggedDeck.delete();
            summary.decks++;
        }

        // Deck.delete() updates disk and in-memory state but emits only
        // SyncEvents.ENTITY_DELETED. The home page re-renders on
        // DeckEvents.EXPAND, so without the dispatch below the user keeps
        // seeing tiles for decks we just removed (the original "Clear all
        // items created during this tutorial" bug — files were gone but
        // the tile stayed put until a manual reload).
        const bAnythingChanged =
            summary.decks > 0 ||
            summary.cards > 0 ||
            summary.studyMaterials > 0 ||
            summary.mockTests > 0;

        if (bAnythingChanged)
        {
            // The user could have been viewing a deck that just got
            // deleted (Start over mid-tutorial). Resolve to a still-live
            // deck before asking the home page to re-expand it.
            const currentDeck     = Deck.getCurrentDeck();
            const bCurrentIsAlive = currentDeck && Deck.getById(currentDeck.getId()) === currentDeck;
            const refreshTarget   = bCurrentIsAlive ? currentDeck : Deck.getRoot();

            if (refreshTarget)
            {
                window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: refreshTarget } }));
            }
        }

        return summary;
    }

    static #hasFlag(additionalData, flagKey)
    {
        return Boolean(additionalData && additionalData[flagKey]);
    }
}

export default TutorialEntityCleanup;
