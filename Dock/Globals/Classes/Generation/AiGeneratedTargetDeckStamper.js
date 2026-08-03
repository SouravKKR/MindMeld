const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const AiGeneratedDeckFields = require("../Security/AiGeneratedDeckFields");
const { aiGeneratedStampResults } = require("../../Enumerations/AiGeneratedStampResults");

/**
 * Marks the deck a generation run was launched FROM as holding AI-generated
 * content.
 *
 * DeckHierarchyBuilder stamps every deck a run CREATES, but the launch deck
 * already existed — it is never inserted into deckKeyToDataMap, so nothing
 * stamped it. That left the one deck the user actually looks at on the home
 * grid holding generated material with its Export button intact and no owner
 * watermark, which is the whole symptom this class exists to fix. It is also
 * where a non-recursive mock-test bundle lands (MockTestAssembler writes
 * straight onto the launch deck), so it can hold generated content even when
 * the run created no deck rows at all.
 *
 * The root deck ("0") is never marked: it contains the user's entire library,
 * and marking it would take Export away from everything they ever made.
 */
class AiGeneratedTargetDeckStamper
{
    static ROOT_DECK_ID = "0";

    /**
     * Marks the launch deck, idempotently.
     *
     * @param {string} userId
     * @param {string} deckId the deck the user launched generation from
     * @returns {Promise<number>} an aiGeneratedStampResults value
     */
    static async markGenerationTargetDeck(userId, deckId)
    {
        if (typeof deckId !== "string" || deckId.length === 0 || deckId === AiGeneratedTargetDeckStamper.ROOT_DECK_ID)
        {
            return aiGeneratedStampResults.ALREADY_MARKED;
        }

        const deckCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

        const existingDeckDocument = await deckCollection.findOne(
            { userId: userId, "data.id": deckId },
            { projection: { _id: 0, "data.additionalData": 1, "data.lifecycle.lastModified": 1 } },
        );

        if (!existingDeckDocument)
        {
            return aiGeneratedStampResults.DECK_NOT_FOUND;
        }

        if (AiGeneratedDeckFields.isMarked(existingDeckDocument.data?.additionalData))
        {
            // Re-generating into the same deck must not bump lastModified. A
            // gratuitous bump would let this untouched server blob beat a newer
            // edit the user made on a device that has not pushed yet.
            return aiGeneratedStampResults.ALREADY_MARKED;
        }

        await deckCollection.updateOne(
            { userId: userId, "data.id": deckId },
            {
                $set:
                {
                    ["data.additionalData." + AiGeneratedDeckFields.AI_GENERATED]: true,
                    "data.lifecycle.lastModified": AiGeneratedTargetDeckStamper.#resolveStampedLastModified(existingDeckDocument),
                    serverUpdatedAt: new Date(),
                },
            },
        );

        return aiGeneratedStampResults.MARKED;
    }

    /**
     * The lastModified value to write, as the ISO string Lifecycle.toJson emits.
     *
     * Bumping it is not optional. SyncApplier.#applyDeckChange returns early
     * when serverLastModified <= localLastModified, so a serverUpdatedAt-only
     * write would be pulled by the client and then discarded — the watermark
     * would never render and Export would never disappear.
     *
     * Taking the max against the stored value keeps that true when the server
     * clock sits behind the timestamp already on the deck (clock skew, or a
     * device whose clock runs fast): a plain `now` could land at or before the
     * client's copy and be silently thrown away.
     */
    static #resolveStampedLastModified(existingDeckDocument)
    {
        const storedLastModifiedValue = existingDeckDocument.data?.lifecycle?.lastModified;
        const storedLastModifiedMilliseconds = storedLastModifiedValue ? new Date(storedLastModifiedValue).getTime() : Number.NaN;

        if (Number.isNaN(storedLastModifiedMilliseconds))
        {
            return new Date().toISOString();
        }

        return new Date(Math.max(Date.now(), storedLastModifiedMilliseconds + 1)).toISOString();
    }
}

module.exports = AiGeneratedTargetDeckStamper;
