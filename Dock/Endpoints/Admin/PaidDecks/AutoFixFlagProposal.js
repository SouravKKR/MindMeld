const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const RefinementTargetLocator = require("../../../Globals/Classes/Generation/RefinementTargetLocator");
const RefinedEntityWriter = require("../../../Globals/Classes/Generation/RefinedEntityWriter");
const RefinementProposalRunner = require("../../../Globals/Classes/Generation/RefinementProposalRunner");
const { refinementTargetKinds } = require("../../../Globals/Enumerations/RefinementTargetKinds");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * POST /Admin/PaidDecks/AutoFixFlagProposal
 *
 * Proposes a correction for ONE verification flag.
 *
 * The verifier already says what is wrong and what the content should say
 * instead — correctStatement has been produced, displayed, and consumed by
 * nothing since the gate was built. This turns it into a starting point: the
 * flag's own problem and correction become the instruction, the passage it
 * quotes is located, and the model proposes the smallest edit that resolves it.
 *
 * It PROPOSES. The flag is not cleared, and the content is not written — both
 * are separate, deliberate acts by a person who has seen the comparison. A
 * one-click "fix and resolve" would turn the review gate into the dismiss button
 * it was specifically built not to be.
 *
 * Unmetered: gated by admin role rather than by balance. The apply endpoint
 * records the spend against the acting administrator so it is still attributable.
 *
 * Runs against BOTH blocking and advisory flags. An advisory flag does not stop
 * a publish, but "imprecise, ambiguous or misleading" is still wrong on content
 * a student paid for, and there is no reason the cheap fix should be reserved
 * for the flags that happen to block.
 */
async function autoFixFlagProposal(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";
    const flagIndex = body?.flagIndex;
    const requestedMainTaskId = typeof body?.mainTaskId === "string" ? body.mainTaskId : "";

    if (deckId.length === 0 || typeof flagIndex !== "number")
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    // Same bridge the review dialog reads through, so the flag is looked up on
    // the record the publish gate will consult rather than on nothing at all.
    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);
    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);

    if (provenanceRecords.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    const provenanceRecord = requestedMainTaskId.length > 0
        ? provenanceRecords.find(candidateRecord => candidateRecord.mainTaskId === requestedMainTaskId) || null
        : (provenanceRecords.length === 1 ? provenanceRecords[0] : null);

    if (provenanceRecord === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({
            error: ErrorCodes.INVALID_REQUEST,
            detail: "This deck was produced by more than one generation run, so a fix must name the run its flag belongs to.",
        });
        return;
    }

    const flags = provenanceRecord.verification && Array.isArray(provenanceRecord.verification.flags)
        ? provenanceRecord.verification.flags
        : [];

    if (flagIndex < 0 || flagIndex >= flags.length)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND, detail: "No such flag on this generation run." });
        return;
    }

    const flag = flags[flagIndex];

    // The deck the generation ran into, plus everything it produced beneath it.
    // Scoping to these is what stops a topic-chain name like "Introduction"
    // resolving into a different unit of the same tree.
    const searchableDeckIds = [provenanceRecord.deckId, ...(Array.isArray(provenanceRecord.producedDeckIds) ? provenanceRecord.producedDeckIds : [])];

    const locateResult = await RefinementTargetLocator.locate({
        ownerUserId: provenanceRecord.generatedByUserId,
        deckIds: searchableDeckIds,
        quotedText: flag.quotedText,
        topicChain: flag.topicChain,
    });

    if (locateResult.outcome === RefinementTargetLocator.OUTCOME_NOT_EDITABLE)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_EDITABLE, detail: locateResult.detail });
        return;
    }

    if (locateResult.outcome === RefinementTargetLocator.OUTCOME_NOT_FOUND)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND, detail: locateResult.detail });
        return;
    }

    if (locateResult.outcome === RefinementTargetLocator.OUTCOME_AMBIGUOUS && typeof body?.entityId !== "string")
    {
        // Handed back for a person to choose between rather than resolved by
        // taking the first. The quoted text is a model-authored excerpt of
        // generated prose, and near-duplicates across sibling topics are normal.
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.REFINEMENT_TARGET_AMBIGUOUS,
            detail: locateResult.detail,
            candidates: locateResult.candidates,
        });
        return;
    }

    const chosenCandidate = typeof body?.entityId === "string"
        ? locateResult.candidates.find(candidate => candidate.entityId === body.entityId && candidate.targetKind === body.targetKind)
        : locateResult.candidates[0];

    if (!chosenCandidate)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
        return;
    }

    const currentState = await RefinedEntityWriter.readTargetContent(
        provenanceRecord.generatedByUserId,
        chosenCandidate.entityId,
        chosenCandidate.targetKind,
    );

    if (!currentState.bFound)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.REFINEMENT_TARGET_NOT_FOUND });
        return;
    }

    let workerResult;

    try
    {
        workerResult = await RefinementProposalRunner.proposeContentRevision({
            targetKind: nameForTargetKind(chosenCandidate.targetKind),
            beforeHtml: currentState.contentValue,
            instruction: buildInstructionFromFlag(flag),
            subjectName: provenanceRecord.deckName || "",
            topicChain: Array.isArray(flag.topicChain) ? flag.topicChain : [],
            referenceSourceUrl: "",
            referenceSourceStoragePath: "",
            referenceSourceMimeType: "",
        });
    }
    catch (workerError)
    {
        response.statusCode = httpStatus.BAD_GATEWAY;
        response.sendJson({ error: ErrorCodes.REFINEMENT_FAILED, detail: workerError.message });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        proposal: {
            mainTaskId: provenanceRecord.mainTaskId,
            flagIndex: flagIndex,
            ownerUserId: provenanceRecord.generatedByUserId,
            targetKind: chosenCandidate.targetKind,
            entityId: chosenCandidate.entityId,
            entityTypeName: chosenCandidate.entityTypeName,
            deckName: chosenCandidate.deckName || "",
            beforeHtml: currentState.contentValue,
            afterHtml: workerResult.revisedHtml,
            baseContentHash: currentState.contentHash,
            summary: workerResult.summary || "",
            concerns: workerResult.concerns || "",
            consultedUrls: Array.isArray(workerResult.consultedUrls) ? workerResult.consultedUrls : [],
            modelIdentifier: workerResult.modelIdentifier || "",
        },
    });
}

/**
 * Turns a verification flag into an instruction the refinement model can act on.
 *
 * The flag's own fields are used verbatim rather than summarised. quotedText
 * says exactly which span to change, problem says what is wrong with it, and
 * correctStatement is the verifier's own answer — reworded, any of the three
 * would become a paraphrase of a paraphrase, and the thing being corrected is
 * usually a value or a definition where the exact wording is the whole point.
 */
function buildInstructionFromFlag(flag)
{
    const instructionParts =
    [
        "A factual verification pass flagged a problem in this passage. Correct it, and change nothing else.",
        `Problem: ${flag.problem || "(not recorded)"}`,
    ];

    if (flag.quotedText)
    {
        instructionParts.push(`The text it objects to: "${flag.quotedText}"`);
    }

    if (flag.correctStatement)
    {
        instructionParts.push(`What it should say instead: ${flag.correctStatement}`);
    }

    instructionParts.push(
        "Make the smallest edit that resolves this. If you believe the flag is mistaken, apply it anyway and say so "
            + "in your summary so the reviewer can decide.",
    );

    return instructionParts.join("\n");
}

function nameForTargetKind(targetKind)
{
    const matchedEntry = Object.entries(refinementTargetKinds).find(([, kindValue]) => kindValue === targetKind);
    return matchedEntry ? matchedEntry[0] : "";
}

module.exports = { autoFixFlagProposal };
