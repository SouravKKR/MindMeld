const RefinedEntityWriter = require("./RefinedEntityWriter");
const ContentRefinementQueryEngine = require("../Database/ContentRefinementQueryEngine");
const { refinementTargetKinds } = require("../../Enumerations/RefinementTargetKinds");

/**
 * ContentRefinementApplier — writes an approved revision and files the record of
 * it, in that order.
 *
 * Shared by the user-facing refinement endpoint and the administrator's
 * verification auto-fix, because the two differ only in who is allowed to call
 * them. Letting each own its own apply would mean two chances to forget the
 * concurrency guard and two records that disagree about what a refinement is.
 *
 * ORDER MATTERS. The content is written first and the record filed second. A
 * record written first would claim a change that may not have landed, and the
 * only thing this collection is for is being trustworthy about what actually
 * happened. The reverse failure — content written, record lost — leaves an
 * unlogged edit, which is worse than nothing but far better than a log that
 * asserts a correction nobody made.
 *
 * The record is filed even when no source was attached. A refinement made from
 * an instruction alone still changed sellable content, and "who changed this,
 * when, on whose instruction, using which model" is the question the record
 * answers; the licence declaration is an additional field on it, not its only
 * reason to exist.
 */
class ContentRefinementApplier
{
    /**
     * @param {object} applyRequest
     *   ownerUserId, actorUserId, entityId, targetKind, revisedContent,
     *   expectedBaseContentHash, instruction, summary, concerns,
     *   modelIdentifier, consultedUrls, visionReviewOutcome, visualMethodName,
     *   attachedSource (nullable), mainTaskId (nullable), flagIndex (nullable)
     * @return {Promise<{bApplied: boolean, reason: (string|null), refinement: (object|null)}>}
     */
    static async apply(applyRequest)
    {
        // A FIGURE refinement rewrites the passage the figure lives in, so by
        // the time it reaches here it has already been resolved to whichever
        // text field holds it. Anything still claiming to be a FIGURE target is
        // a caller that skipped that step.
        if (applyRequest.targetKind === refinementTargetKinds.FIGURE
            || !RefinedEntityWriter.isWritableTargetKind(applyRequest.targetKind))
        {
            return { bApplied: false, reason: "NOT_FOUND", refinement: null };
        }

        const writeResult = await RefinedEntityWriter.applyRevision({
            ownerUserId: applyRequest.ownerUserId,
            entityId: applyRequest.entityId,
            targetKind: applyRequest.targetKind,
            revisedContent: applyRequest.revisedContent,
            expectedBaseContentHash: applyRequest.expectedBaseContentHash,
        });

        if (!writeResult.bWritten)
        {
            return { bApplied: false, reason: writeResult.reason, refinement: null };
        }

        const attachedSource = applyRequest.attachedSource || null;

        let refinement = null;

        try
        {
            refinement = await ContentRefinementQueryEngine.record({
                deckId: writeResult.deckId,
                entityId: applyRequest.entityId,
                entityTypeName: writeResult.entityTypeName,
                targetKindName: ContentRefinementApplier.#nameForTargetKind(applyRequest.targetKind),

                ownerUserId: applyRequest.ownerUserId,
                actorUserId: applyRequest.actorUserId,

                instruction: applyRequest.instruction,
                summary: applyRequest.summary,
                concerns: applyRequest.concerns,
                modelIdentifier: applyRequest.modelIdentifier,

                informationSourceId: attachedSource ? attachedSource.informationSourceId : "",
                sourceHash: attachedSource ? attachedSource.contentHash : "",
                sourceName: attachedSource ? attachedSource.name : "",
                sourceUrl: attachedSource ? attachedSource.sourceUrl : (applyRequest.referenceSourceUrl || ""),
                licenceType: attachedSource ? attachedSource.licenceType : 0,
                licenceNote: attachedSource ? attachedSource.licenceNote : "",

                consultedUrls: applyRequest.consultedUrls,
                visionReviewOutcome: applyRequest.visionReviewOutcome,
                visualMethodName: applyRequest.visualMethodName,

                beforeContentHash: writeResult.beforeContentHash,
                afterContentHash: writeResult.afterContentHash,

                mainTaskId: applyRequest.mainTaskId,
                flagIndex: applyRequest.flagIndex,
            });
        }
        catch (recordError)
        {
            // The content is already written; there is no honest way to take it
            // back, and pretending the apply failed would leave the reviewer
            // re-applying a change that already landed. Report the success and
            // make the gap loud in the log.
            console.error(
                `[ContentRefinementApplier] Wrote entity ${applyRequest.entityId} but FAILED to record the refinement: `
                    + `${recordError?.message || recordError}`,
            );
        }

        return { bApplied: true, reason: null, refinement: refinement };
    }

    static #nameForTargetKind(targetKind)
    {
        const nameByValue = Object.entries(refinementTargetKinds)
            .find(([, kindValue]) => kindValue === targetKind);

        return nameByValue ? nameByValue[0] : "";
    }
}

module.exports = ContentRefinementApplier;
