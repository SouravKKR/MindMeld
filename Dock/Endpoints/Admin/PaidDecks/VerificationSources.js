const crypto = require("crypto");
const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const PaidDeckVerificationSourceQueryEngine = require("../../../Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../../../Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const SourceVerificationRunner = require("../../../Globals/Classes/PaidDeck/SourceVerificationRunner");
const VerificationSourceLicenceGate = require("../../../Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * The four admin operations on a paid deck's verification sources — the
 * documents and URLs its generated content is checked AGAINST.
 *
 * All four live in one file because they are one concern with one invariant
 * between them: a source is only ever attached alongside a permanent licence
 * declaration, and only ever detached alongside a second one. Splitting them
 * across four files would make it possible to add a fifth that writes the
 * working set without the log, which is the one thing that must not happen.
 *
 * WHAT THESE SOURCES ARE NOT. They never enter generation. Paid-deck generation
 * accepts a curriculum or syllabus and nothing else, and writes content from
 * model knowledge — that restriction is enforced by PaidDeckGenerationGate at
 * submission time and stated in every audit trail. These sources are read by the
 * source-grounded verification pass, which runs afterwards over content that
 * already exists and can only raise flags. Anything that would let one of them
 * reach a generation input is a bug of the most serious kind available here.
 */

/**
 * POST /Admin/PaidDecks/VerificationSources/List
 */
async function listVerificationSources(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    if (deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    const [verificationSources, declarations] = await Promise.all([
        PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(provenanceDeckId),
        SourceLicenceDeclarationQueryEngine.findAllByDeckId(provenanceDeckId),
    ]);

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        provenanceDeckId: provenanceDeckId,
        sources: verificationSources,
        // The full history, including sources that are no longer attached. The
        // dialog shows it as its own view: "what is this deck checked against
        // now" and "what has it ever been checked against" are different
        // questions, and only the second one is evidence.
        declarations: declarations,
        maximumSources: PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK,
        runStatus: SourceVerificationRunner.getRunStatus(provenanceDeckId),
    });
}

/**
 * POST /Admin/PaidDecks/VerificationSources/Attach
 *
 * Attaches either an uploaded document (informationSourceId) or a URL
 * (sourceUrl), with a licence declaration that is checked HERE and not only in
 * the browser.
 */
async function attachVerificationSource(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";
    const informationSourceId = typeof body?.informationSourceId === "string" ? body.informationSourceId.trim() : "";
    const sourceUrl = typeof body?.sourceUrl === "string" ? body.sourceUrl.trim() : "";
    const licenceNote = typeof body?.licenceNote === "string" ? body.licenceNote.trim() : "";
    const licenceType = body?.licenceType;
    const providedName = typeof body?.name === "string" ? body.name.trim() : "";

    if (deckId.length === 0 || (informationSourceId.length === 0 && sourceUrl.length === 0))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    // A URL that is not a web address cannot be fetched by anything and would
    // sit in the declaration log looking like evidence. Refused here rather than
    // discovered by the verification pass hours later.
    if (informationSourceId.length === 0 && !/^https?:\/\//i.test(sourceUrl))
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({
            error: ErrorCodes.INVALID_REQUEST,
            detail: "A reference URL must start with http:// or https://.",
        });
        return;
    }

    const licenceDecision = VerificationSourceLicenceGate.evaluate({
        licenceType: licenceType,
        licenceNote: licenceNote,
        sourceUrl: sourceUrl,
    });

    if (!licenceDecision.allowed)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: licenceDecision.errorCode, detail: licenceDecision.detail });
        return;
    }

    const actorUserId = request.user ? request.user.getId() : "";
    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    const existingSources = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(provenanceDeckId);

    if (existingSources.length >= PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.INVALID_REQUEST,
            detail: `A deck can be checked against at most ${PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK} sources. Detach one first.`,
        });
        return;
    }

    let resolvedSource =
    {
        name: providedName || sourceUrl,
        contentHash: "",
        storagePath: "",
        mimeType: "",
    };

    if (informationSourceId.length > 0)
    {
        const informationSource = await InformationSourceQueryEngine.getInformationSourceById(informationSourceId);

        if (informationSource === null)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_FOUND });
            return;
        }

        // Re-checked against the stored record, never trusted from the request —
        // the same rule every other information-source path applies. An
        // administrator may only declare a document they themselves uploaded, so
        // the declaration names someone who actually had the file.
        if (informationSource.getUserId() !== actorUserId)
        {
            response.statusCode = httpStatus.FORBIDDEN;
            response.sendJson({ error: ErrorCodes.INFORMATION_SOURCE_NOT_OWNED });
            return;
        }

        // The URL is written onto the source row as well as onto the
        // declaration. Without this the row would keep saying it has no origin,
        // and a later reader of the source list could not tell where the
        // document came from.
        if (sourceUrl.length > 0 && !informationSource.getSourceUrl())
        {
            informationSource.setSourceUrl(sourceUrl);
            await InformationSourceQueryEngine.saveInformationSource(informationSource);
        }

        resolvedSource =
        {
            name: providedName || informationSource.getName(),
            contentHash: informationSource.getHash() || "",
            // Resolved here, once, from the stored row. The Agent reads this
            // path verbatim and never rebuilds it from parts, so there is one
            // place where a storage path is composed.
            storagePath: `${informationSource.getDirectoryPath()}/${informationSource.getHash()}`,
            mimeType: informationSource.getMimeType() || "",
        };
    }

    const bAlreadyAttached = await PaidDeckVerificationSourceQueryEngine.isAlreadyAttached(
        provenanceDeckId, resolvedSource.contentHash, sourceUrl);

    if (bAlreadyAttached)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.VERIFICATION_SOURCE_ALREADY_ATTACHED,
            detail: "This deck is already being checked against that source.",
        });
        return;
    }

    const attachedAt = Date.now();

    const verificationSource =
    {
        id: crypto.randomUUID(),
        deckId: provenanceDeckId,
        informationSourceId: informationSourceId,
        name: resolvedSource.name,
        sourceUrl: sourceUrl,
        contentHash: resolvedSource.contentHash,
        storagePath: resolvedSource.storagePath,
        mimeType: resolvedSource.mimeType,
        licenceType: Number(licenceType),
        licenceNote: licenceNote,
        declaredByUserId: actorUserId,
        attachedAt: attachedAt,
        detachedAt: 0,
        active: true,
    };

    // The DECLARATION IS WRITTEN FIRST, on purpose. If the process dies between
    // the two writes, the surviving state is a declaration with no working-set
    // row — a source that is logged but not used, which is harmless. The other
    // order would leave a source being used with nothing recording why it was
    // permitted, which is the state this whole feature exists to prevent.
    await SourceLicenceDeclarationQueryEngine.record({
        event: SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,
        deckId: provenanceDeckId,
        verificationSourceId: verificationSource.id,
        informationSourceId: informationSourceId,
        sourceName: verificationSource.name,
        sourceUrl: sourceUrl,
        sourceHash: verificationSource.contentHash,
        mimeType: verificationSource.mimeType,
        licenceType: verificationSource.licenceType,
        licenceNote: licenceNote,
        declaredByUserId: actorUserId,
        declaredByEmail: resolveActorEmail(request),
    });

    await PaidDeckVerificationSourceQueryEngine.attach(verificationSource);

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, source: verificationSource });
}

/**
 * POST /Admin/PaidDecks/VerificationSources/Detach
 */
async function detachVerificationSource(request, response)
{
    const body = await request.getBody();
    const verificationSourceId = typeof body?.verificationSourceId === "string" ? body.verificationSourceId : "";

    if (verificationSourceId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const verificationSource = await PaidDeckVerificationSourceQueryEngine.findById(verificationSourceId);

    if (verificationSource === null)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.VERIFICATION_SOURCE_NOT_FOUND });
        return;
    }

    const bDetached = await PaidDeckVerificationSourceQueryEngine.detach(verificationSourceId, Date.now());

    if (!bDetached)
    {
        // Already detached. Reported as success: the caller asked for a state
        // that already holds, and a second declaration event for a detach that
        // did not happen would put a false act in a permanent log.
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, alreadyDetached: true });
        return;
    }

    await SourceLicenceDeclarationQueryEngine.record({
        event: SourceLicenceDeclarationQueryEngine.EVENT_DETACHED,
        deckId: verificationSource.deckId,
        verificationSourceId: verificationSource.id,
        informationSourceId: verificationSource.informationSourceId,
        sourceName: verificationSource.name,
        sourceUrl: verificationSource.sourceUrl,
        sourceHash: verificationSource.contentHash,
        mimeType: verificationSource.mimeType,
        licenceType: verificationSource.licenceType,
        licenceNote: verificationSource.licenceNote,
        declaredByUserId: request.user ? request.user.getId() : "",
        declaredByEmail: resolveActorEmail(request),
    });

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true, alreadyDetached: false });
}

/**
 * The acting administrator's email address.
 *
 * Read from the user's additionalData, the same place AdminActionAuditor reads
 * it — the User model carries no getEmail(). Denormalised into the declaration
 * because an account can be deleted, and a permanent log naming only a user id
 * that no longer resolves to anyone has lost the fact it was keeping.
 */
function resolveActorEmail(request)
{
    const user = request.user || null;
    const additionalData = user && typeof user.getAdditionalData === "function" ? (user.getAdditionalData() || {}) : {};
    return additionalData.email || "";
}

/**
 * POST /Admin/PaidDecks/VerificationSources/Run
 *
 * Starts a source-grounded verification pass. Returns as soon as it has started:
 * the pass takes minutes, and the dialog polls Status below.
 */
async function runVerificationAgainstSources(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";
    const requestedMainTaskId = typeof body?.mainTaskId === "string" ? body.mainTaskId : "";

    if (deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);
    const provenanceRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(provenanceDeckId);

    if (provenanceRecords.length === 0)
    {
        response.statusCode = httpStatus.NOT_FOUND;
        response.sendJson({ error: ErrorCodes.PROVENANCE_NOT_FOUND });
        return;
    }

    // Which run the flags belong to. A flag index only means something inside
    // the record that raised it, so a deck with several runs must name one —
    // the same rule ResolveVerificationFlag applies, and for the same reason.
    const provenanceRecord = resolveTargetRecord(provenanceRecords, requestedMainTaskId);

    if (provenanceRecord === null)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({
            error: ErrorCodes.INVALID_REQUEST,
            detail: "This deck was produced by more than one generation run, so a check must name the run it applies to.",
        });
        return;
    }

    const verificationSources = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(provenanceDeckId);

    if (verificationSources.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({
            error: ErrorCodes.VERIFICATION_SOURCES_ABSENT,
            detail: "Attach at least one verification source before running the check.",
        });
        return;
    }

    const startResult = SourceVerificationRunner.start({
        provenanceDeckId: provenanceDeckId,
        mainTaskId: provenanceRecord.mainTaskId,
        // From the STORED record, never from the request: the content being
        // checked belongs to whoever ran the generation, not to the acting
        // administrator.
        ownerUserId: provenanceRecord.generatedByUserId,
        subjectName: provenanceRecord.deckName || "",
    });

    if (!startResult.started)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.VERIFICATION_RUN_ALREADY_IN_PROGRESS,
            detail: "A check against these sources is already running for this deck.",
        });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        passId: startResult.passId,
        mainTaskId: provenanceRecord.mainTaskId,
        runStatus: SourceVerificationRunner.getRunStatus(provenanceDeckId),
    });
}

/**
 * POST /Admin/PaidDecks/VerificationSources/Status
 */
async function getVerificationRunStatus(request, response)
{
    const body = await request.getBody();
    const deckId = typeof body?.deckId === "string" ? body.deckId : "";

    if (deckId.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_FIELDS });
        return;
    }

    const provenanceDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(deckId);

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        // Null when no pass has run in THIS process — which includes the case
        // where one ran before a restart. Reported as null rather than as
        // "finished", because this endpoint can only speak for runs it saw; the
        // durable outcome is the flag list on the provenance record, which the
        // review dialog reads separately.
        runStatus: SourceVerificationRunner.getRunStatus(provenanceDeckId),
    });
}

function resolveTargetRecord(provenanceRecords, requestedMainTaskId)
{
    if (typeof requestedMainTaskId === "string" && requestedMainTaskId.length > 0)
    {
        return provenanceRecords.find(record => record.mainTaskId === requestedMainTaskId) || null;
    }

    return provenanceRecords.length === 1 ? provenanceRecords[0] : null;
}

module.exports =
{
    listVerificationSources,
    attachVerificationSource,
    detachVerificationSource,
    runVerificationAgainstSources,
    getVerificationRunStatus,
};
