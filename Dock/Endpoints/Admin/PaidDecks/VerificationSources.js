const crypto = require("crypto");
const GenerationProvenanceQueryEngine = require("../../../Globals/Classes/Database/GenerationProvenanceQueryEngine");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const PaidDeckProvenanceLinkResolver = require("../../../Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const PaidDeckVerificationSourceQueryEngine = require("../../../Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../../../Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const SourceVerificationRunner = require("../../../Globals/Classes/PaidDeck/SourceVerificationRunner");
const VerificationSourceLicenceGate = require("../../../Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
const SourceUsageGate = require("../../../Globals/Classes/PaidDeck/SourceUsageGate");
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
 * WHAT A SOURCE IS USED FOR IS PER SOURCE, and is the usageMode on its row.
 * VERIFICATION_ONLY (the default) means the document is read only by the
 * source-grounded verification pass, which runs after content already exists and
 * can only raise flags — nothing generated was written from it.
 * CONTENT_AND_VERIFICATION means the deck's content may also be WRITTEN from it,
 * which SourceUsageGate permits only under a licence recording a right to create
 * new material.
 * CONTENT_ONLY means the same right is engaged — the deck is written from it —
 * but the document is deliberately kept OUT of the verification pass. That is
 * not a weaker declaration; it is a statement about the document's fitness as a
 * yardstick. A chapter covering a third of the deck, or a past question paper,
 * writes its part well and would flag everything outside its scope as a gap.
 *
 * The bases differ — independent creation for the first, an evidenced licence for
 * the other two — and the audit trail reports them separately, per topic. That is
 * why the mode is a property of the source rather than of the run, and why
 * changing it is logged rather than merely applied.
 *
 * LISTING A SOURCE IS NOT THE SAME AS CHECKING AGAINST IT. The list endpoint
 * below returns every attached row whatever its mode — a content-only source is
 * the one a reviewer most needs to see — while the run endpoint selects only the
 * verification-eligible subset through SourceUsageGate. Confusing the two is how
 * a deck ends up checked against a document the administrator excluded.
 *
 * The ordinary generation source list is untouched by any of this: it still
 * accepts a curriculum or syllabus and nothing else, enforced by
 * PaidDeckGenerationGate. A licensed document reaches generation through this
 * channel, where a licence is declared and the file retained as proof, or not at
 * all. And no document of either kind reaches a PAID_DECK_* model — content
 * sources are read by a generator on its own ModelPool entry outside that
 * namespace.
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
    const usageMode = SourceUsageGate.normaliseUsageMode(body?.usageMode);
    const sourceNote = typeof body?.sourceNote === "string" ? body.sourceNote.trim() : "";

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

    // The stricter question, asked only of a source the administrator wants to
    // GENERATE from: does the declared licence record a right to create new
    // material? A complete declaration is not the same as a derivative right.
    const usageDecision = SourceUsageGate.evaluate({ licenceType: licenceType, usageMode: usageMode });

    if (!usageDecision.allowed)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: usageDecision.errorCode, detail: usageDecision.detail });
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
            detail: `A deck can have at most ${PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK} sources attached. Detach one first.`,
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

        // Written explicitly. This is a plain object literal going straight into
        // Mongo — nothing constructs the codegen'd PaidDeckVerificationSource
        // here — so a field omitted is a field absent from the stored document.
        usageMode: usageMode,
        sourceNote: sourceNote,

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
        usageMode: usageMode,
        sourceNote: sourceNote,
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
 * POST /Admin/PaidDecks/VerificationSources/Update
 *
 * Revises the free-text note on an attached source, or what it is used for.
 *
 * Only these two fields. Everything identifying the document — its hash, storage
 * path, licence, and who declared it when — is fixed at attach time, because
 * those are the facts the record exists to hold; changing one of them is a
 * different source and should be a detach and a re-attach that both show up in
 * the log.
 *
 * The declaration event is written BEFORE the row is updated, the same order and
 * for the same reason as attach: a crash between the two leaves a log saying a
 * change was made that was not, which is a discrepancy a reader can see and
 * investigate. The reverse leaves a silently changed row with nothing recording
 * that anyone decided to change it.
 *
 * The usage change is re-gated against the STORED licence, never one from the
 * request. Otherwise an administrator could attach under a licence that permits
 * only verification and then quietly promote the source to a content source.
 */
async function updateVerificationSource(request, response)
{
    const body = await request.getBody();
    const verificationSourceId = typeof body?.verificationSourceId === "string" ? body.verificationSourceId : "";
    const bHasSourceNote = typeof body?.sourceNote === "string";
    const bHasUsageMode = body?.usageMode !== undefined && body?.usageMode !== null;

    if (verificationSourceId.length === 0 || (!bHasSourceNote && !bHasUsageMode))
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

    if (verificationSource.active !== true)
    {
        response.statusCode = httpStatus.CONFLICT;
        response.sendJson({
            error: ErrorCodes.INVALID_REQUEST,
            detail: "This source has been detached. What it was used for is now a historical fact and cannot be edited.",
        });
        return;
    }

    const previousUsageMode = SourceUsageGate.normaliseUsageMode(verificationSource.usageMode);
    const requestedUsageMode = bHasUsageMode ? SourceUsageGate.normaliseUsageMode(body.usageMode) : previousUsageMode;
    const revisedSourceNote = bHasSourceNote ? body.sourceNote.trim() : (verificationSource.sourceNote || "");

    if (requestedUsageMode !== previousUsageMode)
    {
        const usageDecision = SourceUsageGate.evaluate({
            licenceType: verificationSource.licenceType,
            usageMode: requestedUsageMode,
        });

        if (!usageDecision.allowed)
        {
            response.statusCode = httpStatus.BAD_REQUEST;
            response.sendJson({ error: usageDecision.errorCode, detail: usageDecision.detail });
            return;
        }
    }

    const bUsageChanged = requestedUsageMode !== previousUsageMode;
    const bNoteChanged = bHasSourceNote && revisedSourceNote !== (verificationSource.sourceNote || "");

    if (!bUsageChanged && !bNoteChanged)
    {
        // Nothing actually differs. Reported as success without writing an
        // event: a log entry for a change that did not happen is a false act in
        // a permanent record, which is the one thing this collection must not
        // contain.
        response.statusCode = httpStatus.OK;
        response.sendJson({ success: true, changed: false });
        return;
    }

    await SourceLicenceDeclarationQueryEngine.record({
        // A usage change is the more consequential of the two, so it names the
        // event when both moved at once — the note is carried on the row either
        // way and is visible on the same entry.
        event: bUsageChanged
            ? SourceLicenceDeclarationQueryEngine.EVENT_USAGE_CHANGED
            : SourceLicenceDeclarationQueryEngine.EVENT_NOTE_UPDATED,
        deckId: verificationSource.deckId,
        verificationSourceId: verificationSource.id,
        informationSourceId: verificationSource.informationSourceId,
        sourceName: verificationSource.name,
        sourceUrl: verificationSource.sourceUrl,
        sourceHash: verificationSource.contentHash,
        mimeType: verificationSource.mimeType,
        licenceType: verificationSource.licenceType,
        licenceNote: verificationSource.licenceNote,
        usageMode: requestedUsageMode,
        sourceNote: revisedSourceNote,
        declaredByUserId: request.user ? request.user.getId() : "",
        declaredByEmail: resolveActorEmail(request),
    });

    await PaidDeckVerificationSourceQueryEngine.updateDeclaration(verificationSourceId, {
        sourceNote: revisedSourceNote,
        usageMode: requestedUsageMode,
    });

    response.statusCode = httpStatus.OK;
    response.sendJson({
        success: true,
        changed: true,
        usageMode: requestedUsageMode,
        sourceNote: revisedSourceNote,
    });
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

    const attachedSources = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(provenanceDeckId);
    const verificationSources = SourceUsageGate.selectVerificationSources(attachedSources);

    if (verificationSources.length === 0)
    {
        // Refused here as well as inside the runner, so the dialog gets an
        // immediate answer rather than a pass that starts and fails a moment
        // later. The two refusals share their wording through the runner's
        // static member for exactly that reason.
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({
            error: ErrorCodes.VERIFICATION_SOURCES_ABSENT,
            detail: attachedSources.length === 0
                ? "Attach at least one verification source before running the check."
                : SourceVerificationRunner.EVERY_SOURCE_IS_CONTENT_ONLY_DETAIL,
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
    updateVerificationSource,
    detachVerificationSource,
    runVerificationAgainstSources,
    getVerificationRunStatus,
};
