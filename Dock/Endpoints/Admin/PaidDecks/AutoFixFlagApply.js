const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const ContentRefinementApplier = require("../../../Globals/Classes/Generation/ContentRefinementApplier");
const ContentRefinementRunner = require("../../AutomaticGeneration/Helpers/ContentRefinementRunner");
const CreditLedger = require("../../../Globals/Classes/Credits/CreditLedger");
const { creditTransactionTypes } = require("../../../Globals/Enumerations/CreditTransactionTypes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const crypto = require("crypto");

/**
 * POST /Admin/PaidDecks/AutoFixFlagApply
 *
 * Writes a correction an administrator approved for one verification flag.
 *
 * The deck being edited belongs to whoever ran the generation, which is why this
 * write is server-side at all — that deck is not in the acting administrator's
 * browser, so a client-side apply could never have worked here. ownerUserId is
 * read off the stored provenance record rather than taken from the request, so a
 * crafted body cannot aim the write at another user's content.
 *
 * THE FLAG IS NOT CLEARED HERE. Resolving it stays a separate, deliberate act
 * through /Admin/PaidDecks/ResolveVerificationFlag, which records who decided and
 * why. Clearing it automatically on a successful write would mean the gate was
 * answered by the same process that made the change, which is the thing the gate
 * exists to prevent. The response carries the refinementId so the resolution note
 * can point at the evidence.
 *
 * Unmetered but not unrecorded: a zero-value ledger entry is written so premium
 * model spend on this path is still attributable to an administrator.
 */
async function autoFixFlagApply(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";
    const mainTaskId = typeof body?.mainTaskId === "string" ? body.mainTaskId : "";
    const flagIndex = body?.flagIndex;
    const entityId = typeof body?.entityId === "string" ? body.entityId : "";
    const targetKind = body?.targetKind;
    const revisedContent = typeof body?.revisedContent === "string" ? body.revisedContent : "";
    const expectedBaseContentHash = typeof body?.baseContentHash === "string" ? body.baseContentHash : "";

    if (deckId.length === 0 || mainTaskId.length === 0 || typeof flagIndex !== "number"
        || entityId.length === 0 || typeof targetKind !== "number"
        || revisedContent.length === 0 || expectedBaseContentHash.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);
    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);
    const provenanceRecord = provenanceRecords.find(candidateRecord => candidateRecord.mainTaskId === mainTaskId) || null;

    if (provenanceRecord === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    const applyResult = await ContentRefinementApplier.apply({
        // From the STORED record, never from the request.
        ownerUserId: provenanceRecord.generatedByUserId,
        actorUserId: request.user ? request.user.getId() : "",
        entityId: entityId,
        targetKind: targetKind,
        revisedContent: revisedContent,
        expectedBaseContentHash: expectedBaseContentHash,
        instruction: typeof body?.instruction === "string" ? body.instruction : "",
        summary: typeof body?.summary === "string" ? body.summary : "",
        concerns: typeof body?.concerns === "string" ? body.concerns : "",
        modelIdentifier: typeof body?.modelIdentifier === "string" ? body.modelIdentifier : "",
        consultedUrls: Array.isArray(body?.consultedUrls) ? body.consultedUrls : [],
        visionReviewOutcome: "",
        visualMethodName: "",
        attachedSource: null,
        mainTaskId: mainTaskId,
        flagIndex: flagIndex,
    });

    if (!applyResult.bApplied)
    {
        ContentRefinementRunner.sendApplyFailure(response, applyResult.reason);
        return;
    }

    await recordAttributableSpend(request.user ? request.user.getId() : "", applyResult.refinement);

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        refinementId: applyResult.refinement ? applyResult.refinement.refinementId : null,
        // Stated rather than implied. An administrator who has just watched a
        // correction land will otherwise reasonably assume the flag went with it.
        flagStillUnresolved: true,
    });
}

/**
 * Writes a zero-value ledger entry so the spend is attributable.
 *
 * The admin path is deliberately not metered — an administrator answering a
 * verification flag should not be stopped by a balance — but "not billed" is not
 * a reason for "not recorded". Without this, premium model calls made through
 * this route would appear in no ledger at all.
 */
async function recordAttributableSpend(actorUserId, refinement)
{
    if (actorUserId.length === 0)
    {
        return;
    }

    try
    {
        await CreditLedger.charge(
            actorUserId,
            0,
            creditTransactionTypes.TASK_CHARGE,
            `adminAutoFix:${refinement ? refinement.refinementId : crypto.randomUUID()}`,
            { source: "AdminAutoFixVerificationFlag", refinementId: refinement ? refinement.refinementId : null },
            null,
        );
    }
    catch (ledgerError)
    {
        // The content is already written and recorded. A missing attribution
        // entry is worth a log line, not a failed response that would have the
        // administrator re-apply a change that already landed.
        console.warn(`[AutoFixFlagApply] Could not record attribution for ${actorUserId}: ${ledgerError?.message || ledgerError}`);
    }
}

module.exports = { autoFixFlagApply };
