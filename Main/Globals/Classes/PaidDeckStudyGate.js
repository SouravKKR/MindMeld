import PaidDeckSession from "./Crypto/PaidDeckSession.js";
import Deck from "../Model/Deck.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import ProgressDialog from "../../CommonComponents/ProgressDialog.js";

/**
 * PaidDeckStudyGate
 *
 * The single chokepoint that prepares a paid deck for studying. A paid deck is
 * a normal deck in the tree whose content fields are ciphertext envelopes at
 * rest; before any study mode / AI feature can read them, this gate:
 *
 *   1. ensures the deck's content key is unlocked THIS session — prompting for
 *      the paid-deck password once per browser session (PaidDeckSession holds
 *      the non-extractable key in memory only, lost on reload), and
 *   2. pre-decrypts every card / study material / mock test in the subtree into
 *      the transient in-memory caches the synchronous model accessors read from
 *      (decryptForStudy()).
 *
 * Decryption is idempotent per entity, so re-opening an already-unlocked deck
 * skips straight through with no work and no progress dialog. The first open of
 * a large deck shows a determinate progress bar while it decrypts.
 *
 * A normal (non-paid) deck passes straight through. Returns true when the deck
 * is ready to study, false when the user cancelled / the unlock failed (the
 * caller then aborts opening the study mode).
 */
class PaidDeckStudyGate
{
    // Decrypt this many entities concurrently per batch, yielding to paint
    // between batches so the progress bar animates and the UI stays responsive.
    static #DECRYPT_BATCH_SIZE = 25;

    static async ensureReadyForStudy(deck)
    {
        const paidDeckId = deck?.getAdditionalData?.()?.paidDeckId;
        if (!paidDeckId)
        {
            return true;
        }

        if (!PaidDeckSession.isUnlocked(paidDeckId))
        {
            const enteredPassword = await DialogBox.prompt
            (
                "Unlock paid deck",
                "Enter this deck's password to study it. You'll only be asked once this session.",
                "password"
            );

            if (typeof enteredPassword !== "string" || enteredPassword.length === 0)
            {
                return false;
            }

            const unlockResult = await PaidDeckSession.unlock(paidDeckId, enteredPassword);
            if (!unlockResult || unlockResult.success !== true)
            {
                await DialogBox.alert("Couldn't unlock", "That password didn't work for this deck. Please try again.");
                return false;
            }
        }

        await PaidDeckStudyGate.#decryptSubtree(deck);
        return true;
    }

    /**
     * Re-decrypts cards that arrived encrypted from a background sync for
     * every paid deck whose session is already unlocked this page session.
     * Called from PaidDeckLicenseSyncer after each successful sync so a
     * sync that fires mid-session (or right after purchase) doesn't leave
     * newly-delivered Card objects showing the locked placeholder.
     *
     * Silently no-ops for decks with no new ciphertext (needsDecryption()
     * returns false for cards already cached). No progress dialog — this
     * runs in the background without a triggering user action.
     */
    static async redecryptUnlockedDecks()
    {
        const processedPaidDeckIds = new Set();
        const allDecks = Deck.getAll();

        for (const deck of allDecks)
        {
            const paidDeckId = deck?.getAdditionalData?.()?.paidDeckId;
            if (!paidDeckId || !PaidDeckSession.isUnlocked(paidDeckId) || processedPaidDeckIds.has(paidDeckId))
            {
                continue;
            }
            processedPaidDeckIds.add(paidDeckId);
            await PaidDeckStudyGate.#decryptSubtree(deck, false);
        }
    }

    /**
     * Decrypts every protected content field in the deck subtree into its
     * model's transient cache. Only entities that still hold undecrypted
     * ciphertext are processed, so an already-unlocked + decrypted deck
     * returns instantly. Best-effort per entity — a single decrypt failure
     * leaves that entity showing the locked placeholder rather than aborting.
     *
     * When bShowProgress is true (the default, used when the user explicitly
     * opens a paid deck), a determinate progress bar is shown. Pass false
     * for background calls (e.g. redecryptUnlockedDecks after a sync) so
     * no dialog interrupts the user.
     */
    static async #decryptSubtree(deck, bShowProgress = true)
    {
        const pendingEntities =
        [
            ...deck.getCards(true, true),
            ...deck.getStudyMaterials(true, true),
            ...deck.getMockTests(true)
        ].filter((entity) => typeof entity.needsDecryption === "function" && entity.needsDecryption());

        if (pendingEntities.length === 0)
        {
            return;
        }

        if (!bShowProgress)
        {
            for (let batchStart = 0; batchStart < pendingEntities.length; batchStart += PaidDeckStudyGate.#DECRYPT_BATCH_SIZE)
            {
                const batch = pendingEntities.slice(batchStart, batchStart + PaidDeckStudyGate.#DECRYPT_BATCH_SIZE);
                await Promise.all(batch.map((entity) => entity.decryptForStudy()));
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            return;
        }

        const totalCount = pendingEntities.length;
        const progressDialog = ProgressDialog.show("Retrieving");
        progressDialog.setProgress(0, "Retrieving…");

        try
        {
            let completedCount = 0;
            for (let batchStart = 0; batchStart < pendingEntities.length; batchStart += PaidDeckStudyGate.#DECRYPT_BATCH_SIZE)
            {
                const batch = pendingEntities.slice(batchStart, batchStart + PaidDeckStudyGate.#DECRYPT_BATCH_SIZE);
                await Promise.all(batch.map((entity) => entity.decryptForStudy()));
                completedCount += batch.length;
                await progressDialog.setProgressAndYield(completedCount / totalCount, "Retrieving…");
            }
        }
        finally
        {
            progressDialog.close();
        }
    }
}

export default PaidDeckStudyGate;
