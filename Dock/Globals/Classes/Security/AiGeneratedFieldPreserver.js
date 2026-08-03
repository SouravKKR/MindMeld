const AiGeneratedDeckFields = require("./AiGeneratedDeckFields");

/**
 * AiGeneratedFieldPreserver
 *
 * Keeps the AI-generated marker on a deck once the generation pipeline has set
 * it, whatever a client pushes.
 *
 * SyncQueryEngine.bulkUpsert replaces the WHOLE deck `data` blob, so a client
 * whose local copy predates the marker — or one that has been edited to drop it
 * — erases it permanently on its first winning push, and no pull ever restores
 * it. The deck then gets its Export button and loses its owner watermark, on
 * every device.
 *
 * Force-restore, deliberately NOT overlay-when-absent. The auto-analysis fields
 * honour an explicit client clear because clearing them is a legitimate client
 * action; un-marking AI-generated content never is. The marker is authored by
 * the server and only the server may remove it, which makes this the same shape
 * as the way preservePaidContentOnPush forces paidDeckId back — the reason that
 * marker has always held while this one would not have.
 *
 * A client MAY set the marker on a deck the server has not marked: it only ever
 * removes capability, so an over-claim is harmless and is left alone rather than
 * second-guessed.
 *
 * Kept as its own pure class (no database, no clock) so the invariant is
 * unit-testable in isolation — the caller supplies the stored deck.
 */
class AiGeneratedFieldPreserver
{
    /**
     * Mutates incomingDeckData so the marker survives the push.
     *
     * @param {object} incomingDeckData the client-pushed deck blob
     * @param {object} storedDeckData the server's current deck blob, or null
     * @returns {boolean} true when the marker had to be restored
     */
    static restoreMarker(incomingDeckData, storedDeckData)
    {
        if (!incomingDeckData || !AiGeneratedDeckFields.isMarked(storedDeckData?.additionalData))
        {
            return false;
        }

        if (!incomingDeckData.additionalData || typeof incomingDeckData.additionalData !== "object")
        {
            incomingDeckData.additionalData = {};
        }

        if (AiGeneratedDeckFields.isMarked(incomingDeckData.additionalData))
        {
            return false;
        }

        incomingDeckData.additionalData[AiGeneratedDeckFields.AI_GENERATED] = true;
        return true;
    }
}

module.exports = AiGeneratedFieldPreserver;
