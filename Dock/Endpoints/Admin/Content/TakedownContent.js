const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const DerivedContentQueryEngine = require("../../../Globals/Classes/Database/DerivedContentQueryEngine");
const ContentTakedownNoticeQueryEngine = require("../../../Globals/Classes/Database/ContentTakedownNoticeQueryEngine");
const InformationSourcePurger = require("../../../Globals/Classes/Content/InformationSourcePurger");
const EmbeddedFigurePurger = require("../../../Globals/Classes/Content/EmbeddedFigurePurger");
const TakenDownFigureGuard = require("../../../Globals/Classes/Content/TakenDownFigureGuard");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");
const { httpStatus } = require("../../../Globals/Enumerations/HttpStatus");

/**
 * POST /Admin/Content/Takedown
 *
 * Body: { contentHash: string, noticeReference: string, reason: string, dryRun?: boolean }
 *
 * Actions a rightsholder infringement notice against one uploaded document,
 * identified by its content-addressed sha512 key.
 *
 * This endpoint exists because one uploaded file can be held by any number of
 * accounts, so there is no single owner to ask and no per-user delete that
 * removes the content. Before this, honouring a notice meant hand-editing rows
 * across an unknown number of tenants plus their blobs, the embedding chunks
 * and the cached figures — which meant in practice that a notice could not be
 * honoured at all.
 *
 * The removal deliberately crosses the tenant boundary. That is the point: a
 * notice is about the content, not about one account.
 *
 * Storage is per-user, so N holders means N distinct stored copies rather than
 * one shared blob. Both the dry run and the outcome report the copy count
 * explicitly, and `contentRemoved` is only true when every one of them was
 * deleted — a notice register that records surviving content as removed is
 * worse than one that records the removal as partial.
 *
 * The removal reaches the GENERATED content too. Figures cropped from the
 * document are embedded as base64 inside study material bodies and card faces,
 * which are separate entities that survive the deletion of everything else and
 * have already been synced to devices. Those are stripped and the entities
 * republished, so the removal propagates on the next sync. This is reported
 * separately in both the dry run and the outcome, because rewriting live study
 * material is a bigger intervention than deleting an upload the user may have
 * forgotten, and an operator should see it coming.
 *
 * `dryRun: true` reports exactly what would be removed and changes nothing.
 * Operators should run it first — a takedown is irreversible, and the counts
 * are the only chance to notice that a hash was mistyped before the content is
 * gone.
 *
 * Every takedown is appended to the content-takedown register
 * (ContentTakedownNoticeQueryEngine), which is insert-only, so the platform can
 * later evidence what it removed and on whose notice. The generic admin audit
 * trail records the request itself separately, via the EnsureAdmin gate.
 */
async function takedownContent(request, response)
{
    const requester = request.user;
    if (!requester)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    let body;
    try
    {
        body = await request.getBody();
    }
    catch (bodyError)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "Malformed JSON body." });
        return;
    }

    const contentHash = typeof body?.contentHash === "string" ? body.contentHash.trim() : "";
    if (contentHash.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "contentHash is required.", reason: ErrorCodes.MISSING_CONTENT_HASH });
        return;
    }

    // A notice reference is mandatory even for a dry run. The register's value
    // is that every removal is traceable to the notice that prompted it; an
    // unattributed takedown would be indistinguishable from data loss.
    const noticeReference = typeof body?.noticeReference === "string" ? body.noticeReference.trim() : "";
    if (noticeReference.length === 0)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "noticeReference is required.", reason: ErrorCodes.MISSING_NOTICE_REFERENCE });
        return;
    }

    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    const bIsDryRun = body?.dryRun === true;

    try
    {
        const matchingSources = await InformationSourceQueryEngine.getInformationSourcesByHash(contentHash);
        const derivedCounts = await DerivedContentQueryEngine.countByContentHash(contentHash);
        const embeddedCounts = await EmbeddedFigurePurger.countEmbeddedFigures(contentHash);

        // Nothing anywhere — neither rows nor derived artefacts nor an embedded
        // copy in something already generated. Report it rather than recording a
        // takedown that removed nothing, so a mistyped hash is visible instead of
        // looking like a successful action.
        //
        // The embedded count is part of this test, not just the report: a source
        // row deleted by the reaper months ago can still have left its figures
        // inside live study material, and answering NOT_FOUND to that notice
        // would be wrong.
        if (matchingSources.length === 0
            && derivedCounts.embeddingChunks === 0
            && derivedCounts.figures === 0
            && embeddedCounts.figures === 0)
        {
            response.statusCode = httpStatus.NOT_FOUND;
            response.sendJson({ error: "No content found for that hash.", reason: ErrorCodes.CONTENT_NOT_FOUND });
            return;
        }

        const affectedUserIds = [...new Set(matchingSources.map(informationSource => informationSource.getUserId()).filter(Boolean))];

        if (bIsDryRun)
        {
            const priorNotices = await ContentTakedownNoticeQueryEngine.findByContentHash(contentHash);
            response.sendJson({
                dryRun: true,
                contentHash: contentHash,
                wouldRemove:
                {
                    informationSourceRows: matchingSources.length,
                    affectedUserCount: affectedUserIds.length,
                    // Distinct stored copies, which is not the same number as
                    // rows: storage is per-user, so this is what the notice
                    // actually has to erase from the bucket.
                    storedCopies: InformationSourcePurger.countStoredCopies(matchingSources, contentHash),
                    embeddingChunks: derivedCounts.embeddingChunks,
                    figures: derivedCounts.figures,
                    // The copies a reader can actually see. Reported separately
                    // from the figure cache above because they are a different
                    // removal with a different blast radius: rewriting these
                    // edits study material the user is part-way through.
                    embeddedFigures: embeddedCounts.figures,
                    studyMaterialsToRewrite: embeddedCounts.studyMaterials,
                    cardsToRewrite: embeddedCounts.cards,
                    sourceNames: [...new Set(matchingSources.map(informationSource => informationSource.getName()))]
                },
                priorNoticeCount: priorNotices.length
            });
            return;
        }

        const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(contentHash);

        // The register is now the guard's source of truth for what may never be
        // re-accepted on a sync push, so it has to see this notice before the
        // next one arrives. Other processes pick it up when their own cache
        // lapses; this makes the single-process case immediate.
        TakenDownFigureGuard.invalidateCache();

        const recordedNotice = await ContentTakedownNoticeQueryEngine.record
        ({
            contentHash: contentHash,
            noticeReference: noticeReference,
            reason: reason,
            actorUserId: requester.getId(),
            actorEmail: (requester.getAdditionalData() || {}).email || null,
            rowsRemoved: purgeResult.rowsRemoved,
            rowsFailed: purgeResult.rowsFailed,
            affectedUserIds: purgeResult.affectedUserIds,
            storedCopiesFound: purgeResult.storedCopiesFound,
            storedCopiesRemoved: purgeResult.storedCopiesRemoved,
            bContentRemoved: purgeResult.bContentRemoved,
            embeddingChunksRemoved: purgeResult.embeddingChunksRemoved,
            figuresRemoved: purgeResult.figuresRemoved,
            figureObjectsRemoved: purgeResult.figureObjectsRemoved,
            embeddedFiguresStripped: purgeResult.embeddedFiguresStripped,
            studyMaterialsRewritten: purgeResult.studyMaterialsRewritten,
            cardsRewritten: purgeResult.cardsRewritten,
            unstrippableDocumentCount: purgeResult.unstrippableDocumentCount,
            storageError: purgeResult.storageError
        });

        // A storage failure still returns 200 with the record attached — the
        // rows are gone and the notice is registered, so the operator needs the
        // partial outcome reported rather than an error that hides it. Re-running
        // the takedown is safe and will retry the storage step.
        //
        // storedCopiesFound vs storedCopiesRemoved is the pair that makes a
        // partial removal legible: contentRemoved alone cannot distinguish "no
        // copies existed" from "some copies survived", and the operator has to
        // know which before replying to the rightsholder.
        response.sendJson({
            ok: true,
            noticeId: recordedNotice.id,
            removed:
            {
                informationSourceRows: purgeResult.rowsRemoved,
                informationSourceRowsFailed: purgeResult.rowsFailed,
                affectedUserCount: purgeResult.affectedUserIds.length,
                storedCopiesFound: purgeResult.storedCopiesFound,
                storedCopiesRemoved: purgeResult.storedCopiesRemoved,
                contentRemoved: purgeResult.bContentRemoved,
                embeddingChunks: purgeResult.embeddingChunksRemoved,
                figures: purgeResult.figuresRemoved,
                figureObjects: purgeResult.figureObjectsRemoved,
                embeddedFigures: purgeResult.embeddedFiguresStripped,
                studyMaterialsRewritten: purgeResult.studyMaterialsRewritten,
                cardsRewritten: purgeResult.cardsRewritten,
                entitiesLeftUnmodified: purgeResult.unstrippableDocumentCount
            },
            storageError: purgeResult.storageError
        });
    }
    catch (takedownError)
    {
        console.error(`[TakedownContent] ${takedownError.message}`);
        response.statusCode = httpStatus.INTERNAL_SERVER_ERROR;
        response.sendJson({ error: takedownError.message || "Takedown failed." });
    }
}

module.exports = { takedownContent };
