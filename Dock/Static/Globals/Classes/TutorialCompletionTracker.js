import IndexedDbHelper from "./IndexedDbHelper.js";

/**
 * TutorialCompletionTracker
 *
 * Stores the per-device record of which tutorials have been completed or
 * skipped. Backed by IndexedDB so the state survives reloads (and is
 * distinct from server-side, per-user state — tutorials are explicitly
 * once-per-device, not once-per-login).
 *
 * Storage shape (single keyValueStore entry):
 *   { [tutorialId]: { completed: true, completedAt: isoString, bSkipped: bool } }
 */
class TutorialCompletionTracker
{
    static #STORAGE_KEY = "tutorialCompletionState";

    static #cachedState = null;

    static async #loadState()
    {
        if (TutorialCompletionTracker.#cachedState)
        {
            return TutorialCompletionTracker.#cachedState;
        }

        const stored = await IndexedDbHelper.getValue(TutorialCompletionTracker.#STORAGE_KEY);
        TutorialCompletionTracker.#cachedState = (stored && typeof stored === "object") ? stored : {};

        return TutorialCompletionTracker.#cachedState;
    }

    static async #saveState()
    {
        await IndexedDbHelper.setValue(
            TutorialCompletionTracker.#STORAGE_KEY,
            TutorialCompletionTracker.#cachedState || {}
        );
    }

    static async isCompleted(tutorialId)
    {
        const state = await TutorialCompletionTracker.#loadState();
        return Boolean(state[tutorialId]?.completed);
    }

    static async markCompleted(tutorialId, bSkipped = false)
    {
        const state = await TutorialCompletionTracker.#loadState();

        state[tutorialId] =
        {
            completed:   true,
            completedAt: new Date().toISOString(),
            bSkipped:    bSkipped
        };

        await TutorialCompletionTracker.#saveState();
    }

    static async clearCompletion(tutorialId)
    {
        const state = await TutorialCompletionTracker.#loadState();

        if (state[tutorialId])
        {
            delete state[tutorialId];
            await TutorialCompletionTracker.#saveState();
        }
    }

    static async getAllCompletedIds()
    {
        const state = await TutorialCompletionTracker.#loadState();
        return Object.keys(state).filter(tutorialId => state[tutorialId]?.completed);
    }
}

export default TutorialCompletionTracker;
