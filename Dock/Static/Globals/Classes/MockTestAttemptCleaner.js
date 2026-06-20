import DialogBox from "../../CommonComponents/DialogBox.js";

/**
 * MockTestAttemptCleaner
 *
 * Shared confirmation + bulk-clear flow for wiping every attempt
 * recorded under a deck (including all sub-decks). Used by the deck
 * editor and the browse-mock-tests page so the same prompt + save +
 * partial-failure handling lives in one place.
 */
class MockTestAttemptCleaner
{
    /**
     * Prompts the user, then clears `getHistory()` on every mock test
     * that has any attempt recorded under `deck` (recursive). Saves
     * each modified mock test through its own `save()` so the sync
     * layer picks the change up entity-by-entity rather than via a
     * full deck rewrite.
     *
     * @param {Deck} deck — the deck whose mock-test attempts should be wiped.
     * @returns {Promise<{cleared: number, failed: number, attemptCount: number}>}
     *   counts the caller can use to refresh adjacent UI (e.g. the
     *   browser list).
     */
    static async clearForDeck(deck)
    {
        if (!deck)
        {
            return { cleared: 0, failed: 0, attemptCount: 0 };
        }

        const allMockTests = typeof deck.getMockTests === "function" ? deck.getMockTests(true) : [];
        const mockTestsWithAttempts = allMockTests.filter((mockTest) =>
        {
            const history = mockTest.getHistory ? mockTest.getHistory() : [];
            return Array.isArray(history) && history.length > 0;
        });

        if (mockTestsWithAttempts.length === 0)
        {
            await DialogBox.alert
            (
                "Clear Mock Test Attempts",
                "No mock test under this deck has any recorded attempts."
            );
            return { cleared: 0, failed: 0, attemptCount: 0 };
        }

        const totalAttemptCount = mockTestsWithAttempts.reduce
        (
            (runningTotal, mockTest) => runningTotal + mockTest.getHistory().length,
            0
        );

        const confirmed = await DialogBox.confirm
        (
            "Clear Mock Test Attempts",
            `This will delete all ${totalAttemptCount} attempt${totalAttemptCount === 1 ? "" : "s"} across ${mockTestsWithAttempts.length} mock test${mockTestsWithAttempts.length === 1 ? "" : "s"} under this deck (including subdecks).<br><br>This action cannot be undone.`
        );

        if (!confirmed)
        {
            return { cleared: 0, failed: 0, attemptCount: 0 };
        }

        const failures = [];
        for (const mockTest of mockTestsWithAttempts)
        {
            mockTest.clearAttempts();
            try
            {
                await mockTest.save();
            }
            catch (saveError)
            {
                console.error("[MockTestAttemptCleaner] Failed to save mock test after clearing attempts:", saveError);
                failures.push(mockTest.getTitle ? mockTest.getTitle() : mockTest.getId());
            }
        }

        if (failures.length > 0)
        {
            await DialogBox.alert
            (
                "Clear Mock Test Attempts",
                `Attempts were cleared locally for all ${mockTestsWithAttempts.length} mock test${mockTestsWithAttempts.length === 1 ? "" : "s"}, but ${failures.length} could not be saved. Try again.`
            );
        }

        const result =
        {
            cleared: mockTestsWithAttempts.length - failures.length,
            failed: failures.length,
            attemptCount: totalAttemptCount
        };
        return result;
    }
}

export default MockTestAttemptCleaner;
