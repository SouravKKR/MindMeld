const crypto = require("crypto");
const DatabaseConnector = require("../Database/DatabaseConnector");
const DatabaseConstants = require("../../Constants/DatabaseConstants");
const { refinementTargetKinds } = require("../../Enumerations/RefinementTargetKinds");

/**
 * RefinedEntityWriter — the ONE place an approved content refinement is written.
 *
 * Everything upstream of this class proposes. A model produces a candidate
 * revision, a person compares it against what is there today, and only then does
 * anything reach the database — through here.
 *
 * Why the write is server-side at all. The obvious alternative is to let the
 * client apply the change through the model layer it already uses for manual
 * edits. That works for a user refining their own deck and does not work for the
 * case the feature exists to serve: an administrator answering a verification
 * flag is editing a deck owned by whoever ran the generation, which is not in
 * the administrator's browser and never will be. One write path that handles
 * both beats two that disagree at the edges.
 *
 * Why it does NOT go through SyncQueryEngine. Those upserts take a whole entity
 * document and replace it, which means reconstructing every field this class
 * does not care about and quietly dropping any the caller did not know to carry.
 * They also answer "I did not write" and "there was no such row" with the same
 * bare false. A targeted $set on the one content field, modelled on
 * AiGeneratedTargetDeckStamper, changes exactly what was approved.
 *
 * The concurrency guard is the load-bearing part. The write stamps
 * lastModified past whatever is stored, because SyncApplier discards a pulled
 * change that is not strictly newer than the local copy — so an unbumped write
 * would land in Mongo and never reach the device. That same stamp means this
 * write ALWAYS beats a concurrent edit made on the owner's device and not yet
 * pushed. So the proposal carries a hash of the content it was generated from,
 * and if the stored content no longer hashes to it, nothing is written and the
 * caller is told to regenerate. Without that check, "refine a typo" could
 * silently destroy an afternoon of offline editing.
 */
class RefinedEntityWriter
{
    /**
     * Which collection and which field each target kind writes to. Keeping the
     * mapping in one table is what stops a card answer being written over a card
     * question by a caller that passed the wrong constant.
     */
    static #TARGET_DEFINITIONS =
    {
        [refinementTargetKinds.STUDY_MATERIAL]:
        {
            collectionName: DatabaseConstants.STUDY_MATERIALS_COLLECTION,
            contentFieldName: "content",
            entityTypeName: "STUDY_MATERIAL",
        },
        [refinementTargetKinds.CARD_QUESTION]:
        {
            collectionName: DatabaseConstants.CARDS_COLLECTION,
            contentFieldName: "question",
            entityTypeName: "CARD",
        },
        [refinementTargetKinds.CARD_ANSWER]:
        {
            collectionName: DatabaseConstants.CARDS_COLLECTION,
            contentFieldName: "answer",
            entityTypeName: "CARD",
        },
    };

    /**
     * A FIGURE refinement rewrites the passage the figure sits in, so it is not
     * a target kind of its own here — the caller resolves it to whichever text
     * field holds the figure and writes that.
     */
    static isWritableTargetKind(targetKind)
    {
        return Object.prototype.hasOwnProperty.call(RefinedEntityWriter.#TARGET_DEFINITIONS, targetKind);
    }

    static describeTargetKind(targetKind)
    {
        return RefinedEntityWriter.#TARGET_DEFINITIONS[targetKind] || null;
    }

    /**
     * Hash of a content string, used to detect that the passage moved between
     * the proposal and the approval. Whitespace is NOT normalised: the question
     * is "is this the exact text the proposal was built from", and a revision
     * that only changed spacing is still a revision this proposal did not see.
     */
    static computeContentHash(contentValue)
    {
        return crypto.createHash("sha256").update(String(contentValue ?? ""), "utf8").digest("hex");
    }

    /**
     * Reads the current content of one entity without writing anything. Used to
     * build a proposal, so the hash recorded on it is the hash of what the
     * server actually holds rather than of whatever the client had on screen.
     *
     * @return {Promise<{bFound: boolean, contentValue: string, contentHash: string, deckId: string, entityTypeName: string, storedLastModifiedMilliseconds: number}>}
     */
    static async readTargetContent(ownerUserId, entityId, targetKind)
    {
        const targetDefinition = RefinedEntityWriter.#TARGET_DEFINITIONS[targetKind];

        if (!targetDefinition)
        {
            return RefinedEntityWriter.#buildMissingState();
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(targetDefinition.collectionName);
        const storedDocument = await collection.findOne(
            { userId: ownerUserId, "data.id": entityId },
            { projection: { _id: 0, data: 1 } },
        );

        if (!storedDocument || !storedDocument.data)
        {
            return RefinedEntityWriter.#buildMissingState();
        }

        const contentValue = storedDocument.data[targetDefinition.contentFieldName];

        // A paid-deck buyer's copy stores an encrypted envelope in this field
        // rather than a string. Refinement has no business there — the seller's
        // ciphertext is not the buyer's to rewrite, and the client withholds the
        // option — but the server must not depend on the client for that.
        if (typeof contentValue !== "string")
        {
            return RefinedEntityWriter.#buildMissingState();
        }

        const storedLastModifiedValue = storedDocument.data.lifecycle ? storedDocument.data.lifecycle.lastModified : null;
        const storedLastModifiedMilliseconds = storedLastModifiedValue ? new Date(storedLastModifiedValue).getTime() : Number.NaN;

        return {
            bFound: true,
            contentValue: contentValue,
            contentHash: RefinedEntityWriter.computeContentHash(contentValue),
            deckId: storedDocument.data.deckId || "",
            entityTypeName: targetDefinition.entityTypeName,
            storedLastModifiedMilliseconds: Number.isNaN(storedLastModifiedMilliseconds) ? 0 : storedLastModifiedMilliseconds,
        };
    }

    static #buildMissingState()
    {
        return {
            bFound: false,
            contentValue: "",
            contentHash: "",
            deckId: "",
            entityTypeName: "",
            storedLastModifiedMilliseconds: 0,
        };
    }

    /**
     * Applies an approved revision.
     *
     * @param {object} writeRequest
     *   ownerUserId, entityId, targetKind, revisedContent, expectedBaseContentHash
     * @return {Promise<{bWritten: boolean, reason: (string|null), beforeContentHash: string, afterContentHash: string, deckId: string, entityTypeName: string}>}
     *   reason is "NOT_FOUND" or "BASE_CONTENT_CHANGED" when bWritten is false.
     */
    static async applyRevision(writeRequest)
    {
        const targetDefinition = RefinedEntityWriter.#TARGET_DEFINITIONS[writeRequest.targetKind];

        if (!targetDefinition)
        {
            return RefinedEntityWriter.#buildFailure("NOT_FOUND");
        }

        const currentState = await RefinedEntityWriter.readTargetContent(
            writeRequest.ownerUserId,
            writeRequest.entityId,
            writeRequest.targetKind,
        );

        if (!currentState.bFound)
        {
            return RefinedEntityWriter.#buildFailure("NOT_FOUND");
        }

        if (currentState.contentHash !== writeRequest.expectedBaseContentHash)
        {
            // The passage changed after the proposal was built — another device
            // synced an edit, or a second refinement was approved first. Writing
            // now would silently discard that change, and the person approving
            // this revision was looking at a "before" that no longer exists.
            return RefinedEntityWriter.#buildFailure("BASE_CONTENT_CHANGED", currentState);
        }

        const collection = (await DatabaseConnector.getDatabase()).collection(targetDefinition.collectionName);

        await collection.updateOne(
            { userId: writeRequest.ownerUserId, "data.id": writeRequest.entityId },
            {
                $set:
                {
                    ["data." + targetDefinition.contentFieldName]: writeRequest.revisedContent,
                    "data.lifecycle.lastModified": RefinedEntityWriter.#resolveStampedLastModified(currentState.storedLastModifiedMilliseconds),
                    serverUpdatedAt: new Date(),
                },
            },
        );

        return {
            bWritten: true,
            reason: null,
            beforeContentHash: currentState.contentHash,
            afterContentHash: RefinedEntityWriter.computeContentHash(writeRequest.revisedContent),
            deckId: currentState.deckId,
            entityTypeName: currentState.entityTypeName,
        };
    }

    /**
     * The lastModified to write, as the ISO string Lifecycle.toJson emits.
     *
     * Bumping it is not optional: SyncApplier returns early when the pulled
     * copy is not strictly newer than the local one, so a serverUpdatedAt-only
     * write is pulled and then thrown away — the correction would sit in Mongo
     * and never appear on the device that needs it.
     *
     * Taking the max against the stored value keeps that true when the server
     * clock sits behind the timestamp already on the entity (clock skew, or a
     * device whose clock runs fast). Same reasoning, same shape, as
     * AiGeneratedTargetDeckStamper.
     */
    static #resolveStampedLastModified(storedLastModifiedMilliseconds)
    {
        if (!storedLastModifiedMilliseconds || storedLastModifiedMilliseconds <= 0)
        {
            return new Date().toISOString();
        }

        return new Date(Math.max(Date.now(), storedLastModifiedMilliseconds + 1)).toISOString();
    }

    static #buildFailure(reason, currentState = null)
    {
        return {
            bWritten: false,
            reason: reason,
            beforeContentHash: currentState ? currentState.contentHash : "",
            afterContentHash: "",
            deckId: currentState ? currentState.deckId : "",
            entityTypeName: currentState ? currentState.entityTypeName : "",
        };
    }
}

module.exports = RefinedEntityWriter;
