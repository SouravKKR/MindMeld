const crypto = require("crypto");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const PaidDeckVerificationSourceQueryEngine = require("../../../Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../../../Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const VerificationSourceLicenceGate = require("../../../Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
const SourceUsageGate = require("../../../Globals/Classes/PaidDeck/SourceUsageGate");
const { sourceUsageModes } = require("../../../Globals/Enumerations/SourceUsageModes");
const ErrorCodes = require("../../../Globals/Constants/ErrorCodes");

/**
 * VerificationSourceAdmission — admits the verification sources an
 * administrator picked when launching a paid-deck generation.
 *
 * These are checked at SUBMISSION TIME and attached at PERSISTENCE TIME, and
 * the split is deliberate. The check has to happen before the run starts, or an
 * administrator learns their licence declaration was incomplete twenty minutes
 * into a generation. The attachment cannot happen until afterwards, because the
 * deck these sources belong to does not exist until MoveToDatabase creates it.
 *
 * THESE NEVER ENTER THE GENERATION SOURCE LIST, and the separation is structural
 * rather than conventional: they travel in their own request field, they are
 * never added to informationSources, and they are never seen by
 * validateGenerationSettings or PaidDeckGenerationGate — which continue to
 * accept a curriculum or syllabus and refuse everything else.
 *
 * That separation is what lets a source be admitted as CONTENT without weakening
 * the gate. A source picked here carries a licence declaration and a usage mode;
 * one placed in informationSources carries neither, which is exactly why the
 * gate refuses everything but a syllabus there and why it still does. The two
 * lists mean different things and must stay impossible to confuse:
 *
 *   informationSources  — what the pipeline was told to generate from, gated on
 *                         type, no licence recorded, never a third-party work.
 *   verificationSources — declared documents, each with a licence and a usage
 *                         mode, retained as proof of the basis for using them.
 *
 * THE FIELD NAME IS NARROWER THAN WHAT IT CARRIES, and renaming it now would
 * break replayed payloads for no gain. It is the list of DECLARED sources; the
 * usage mode on each says whether it is written from, checked against, or both.
 * A source in it may well never be checked against anything.
 *
 * A source admitted for CONTENT is read by a generator wired to its own
 * ModelPool entry outside the PAID_DECK_* namespace, so the route boundary
 * ("nothing that reaches a PAID_DECK_* entry has ever seen a third-party
 * document") stays literally true.
 */
class VerificationSourceAdmission
{
    /**
     * A run may generate from at most this many licensed sources.
     *
     * Well below MAXIMUM_SOURCES_PER_DECK, and for a different reason. A
     * verification source is read once per checked item; a content source is
     * held in memory as a retrieval corpus for the whole mapping stage, at
     * AdminSourceCorpus.CHARACTER_BUDGET_PER_SOURCE each, in the same process
     * that has already been killed by the OOM reaper on the production box.
     * Twelve textbooks would be several million characters plus their index.
     *
     * BOTH content-bearing modes count against it. The cost this bounds is the
     * corpus, and CONTENT_ONLY loads exactly the same corpus as
     * CONTENT_AND_VERIFICATION — declining to check the deck against a document
     * afterwards frees no memory during the stage that reads it.
     */
    static MAXIMUM_CONTENT_SOURCES_PER_RUN = 4;

    /**
     * Normalises the request field into the internal shape.
     *
     * Accepts BOTH the current form — `[{informationSourceId, usageMode,
     * sourceNote}]` — and the bare `string[]` of ids this field used to be. The
     * legacy form is not dead weight: a paused run's payload is replayed
     * verbatim by TaskStateClient, and TASK_STATES_TTL_DAYS means a body saved
     * before this shipped can still arrive a week later. A resumed run must not
     * fail because the field it was saved with has since grown fields.
     *
     * A legacy entry reads as VERIFICATION_ONLY with no note, which is exactly
     * what it meant when it was written.
     */
    static #normaliseRequests(verificationSourceRequests)
    {
        if (!Array.isArray(verificationSourceRequests))
        {
            return [];
        }

        const normalisedRequests = [];

        for (const requestEntry of verificationSourceRequests)
        {
            if (typeof requestEntry === "string")
            {
                if (requestEntry.length > 0)
                {
                    normalisedRequests.push({
                        informationSourceId: requestEntry,
                        usageMode: sourceUsageModes.VERIFICATION_ONLY,
                        sourceNote: "",
                    });
                }
                continue;
            }

            const informationSourceId = requestEntry && typeof requestEntry.informationSourceId === "string"
                ? requestEntry.informationSourceId
                : "";

            if (informationSourceId.length === 0)
            {
                continue;
            }

            normalisedRequests.push({
                informationSourceId: informationSourceId,
                usageMode: SourceUsageGate.normaliseUsageMode(requestEntry.usageMode),
                sourceNote: typeof requestEntry.sourceNote === "string" ? requestEntry.sourceNote.trim().slice(0, 2048) : "",
            });
        }

        return normalisedRequests;
    }

    /**
     * The subset of admitted sources the pipeline may WRITE from.
     *
     * Kept as a named selector rather than an inline filter so there is one
     * definition of "is this a content source" on the server, and so every
     * caller that hands sources to a generator is visibly going through it.
     * Delegates to SourceUsageGate, which owns the rule, so widening what counts
     * as content is one edit in one file rather than one per call site.
     *
     * @param {object[]} resolvedSources
     * @return {object[]}
     */
    static selectContentSources(resolvedSources)
    {
        return SourceUsageGate.selectContentSources(resolvedSources);
    }

    /**
     * Checks the picked sources before the run is allowed to start.
     *
     * Every source must belong to the acting administrator and must already
     * carry a complete licence declaration — the picker only offers sources that
     * do, and this re-checks it server-side against the stored row rather than
     * trusting that. A source the administrator asked to GENERATE from is
     * additionally put through SourceUsageGate, which asks the stricter question
     * of whether the declared licence records a right to create new material.
     *
     * Refuses the whole run on the first violation, before any task is
     * scheduled. Silently downgrading one source to verification-only would be
     * worse than refusing: the run would succeed, the deck would be written from
     * model knowledge, and the administrator would believe it was written from
     * the document they licensed.
     *
     * @param {Array<string|{informationSourceId: string, usageMode: number, sourceNote: string}>} verificationSourceRequests
     * @param {string} actorUserId
     * @return {Promise<{allowed: boolean, errorCode: (string|null), detail: (string|null), resolvedSources: object[]}>}
     */
    static async resolveAndValidate(verificationSourceRequests, actorUserId)
    {
        const requestedSources = VerificationSourceAdmission.#normaliseRequests(verificationSourceRequests);

        if (requestedSources.length === 0)
        {
            return VerificationSourceAdmission.#allow([]);
        }

        if (requestedSources.length > PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK)
        {
            return VerificationSourceAdmission.#refuse(
                ErrorCodes.INVALID_REQUEST,
                `A deck can have at most ${PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK} licensed sources attached.`,
            );
        }

        const contentSourceCount = requestedSources.filter(
            requestedSource => SourceUsageGate.isContentUsage(requestedSource.usageMode)).length;

        if (contentSourceCount > VerificationSourceAdmission.MAXIMUM_CONTENT_SOURCES_PER_RUN)
        {
            return VerificationSourceAdmission.#refuse(
                ErrorCodes.INVALID_REQUEST,
                `A run can write content from at most ${VerificationSourceAdmission.MAXIMUM_CONTENT_SOURCES_PER_RUN} `
                + "licensed sources. The rest can still be attached to check the deck against.",
            );
        }

        const resolvedSources = [];

        for (const requestedSource of requestedSources)
        {
            const informationSourceId = requestedSource.informationSourceId;
            const informationSource = await InformationSourceQueryEngine.getInformationSourceById(informationSourceId);

            if (informationSource === null)
            {
                return VerificationSourceAdmission.#refuse(
                    ErrorCodes.INFORMATION_SOURCE_NOT_FOUND,
                    "One of the chosen verification sources no longer exists.",
                );
            }

            if (informationSource.getUserId() !== actorUserId)
            {
                return VerificationSourceAdmission.#refuse(
                    ErrorCodes.INFORMATION_SOURCE_NOT_OWNED,
                    "A verification source must be a document you uploaded yourself.",
                );
            }

            const licenceDecision = VerificationSourceLicenceGate.evaluate({
                licenceType: informationSource.getLicenceType(),
                licenceNote: informationSource.getLicenceNote(),
                sourceUrl: informationSource.getSourceUrl(),
            });

            if (!licenceDecision.allowed)
            {
                return VerificationSourceAdmission.#refuse(
                    licenceDecision.errorCode,
                    `"${informationSource.getName()}" cannot be used as a verification source: ${licenceDecision.detail}`,
                );
            }

            // The second, stricter question — asked against the STORED licence,
            // never a licence the request claimed. Only reached once the
            // declaration itself is complete, but it does not rely on that:
            // SourceUsageGate refuses UNSPECIFIED on its own account too.
            const usageDecision = SourceUsageGate.evaluate({
                licenceType: informationSource.getLicenceType(),
                usageMode: requestedSource.usageMode,
            });

            if (!usageDecision.allowed)
            {
                return VerificationSourceAdmission.#refuse(
                    usageDecision.errorCode,
                    `"${informationSource.getName()}" cannot be used to write deck content: ${usageDecision.detail}`,
                );
            }

            resolvedSources.push({
                informationSourceId: informationSource.getId(),
                name: informationSource.getName(),
                contentHash: informationSource.getHash() || "",
                storagePath: `${informationSource.getDirectoryPath()}/${informationSource.getHash()}`,
                mimeType: informationSource.getMimeType() || "",
                sourceUrl: informationSource.getSourceUrl() || "",
                licenceType: informationSource.getLicenceType(),
                licenceNote: informationSource.getLicenceNote() || "",
                usageMode: requestedSource.usageMode,
                sourceNote: requestedSource.sourceNote,
            });
        }

        return VerificationSourceAdmission.#allow(resolvedSources);
    }

    /**
     * Attaches the admitted sources to the deck the run produced, and records a
     * permanent declaration for each.
     *
     * Called after MoveToDatabase, because until then there is no deck id to
     * attach them to.
     *
     * @return {Promise<number>} How many were attached.
     */
    static async attachToGeneratedDeck({ provenanceDeckId, resolvedSources, actorUserId, actorEmail })
    {
        if (typeof provenanceDeckId !== "string" || provenanceDeckId.length === 0)
        {
            return 0;
        }

        let attachedCount = 0;
        const attachedAt = Date.now();

        for (const resolvedSource of (resolvedSources || []))
        {
            const bAlreadyAttached = await PaidDeckVerificationSourceQueryEngine.isAlreadyAttached(
                provenanceDeckId, resolvedSource.contentHash, resolvedSource.sourceUrl);

            if (bAlreadyAttached)
            {
                continue;
            }

            const verificationSource =
            {
                id: crypto.randomUUID(),
                deckId: provenanceDeckId,
                informationSourceId: resolvedSource.informationSourceId,
                name: resolvedSource.name,
                sourceUrl: resolvedSource.sourceUrl,
                contentHash: resolvedSource.contentHash,
                storagePath: resolvedSource.storagePath,
                mimeType: resolvedSource.mimeType,
                licenceType: resolvedSource.licenceType,
                licenceNote: resolvedSource.licenceNote,

                // Written explicitly rather than left to the codegen defaults:
                // nothing constructs PaidDeckVerificationSource here, this is a
                // plain object literal going straight into Mongo, so a field
                // omitted here is a field absent from the stored document.
                usageMode: SourceUsageGate.normaliseUsageMode(resolvedSource.usageMode),
                sourceNote: resolvedSource.sourceNote || "",

                declaredByUserId: actorUserId,
                attachedAt: attachedAt,
                detachedAt: 0,
                active: true,
            };

            // Declaration first, working-set row second — the same order the
            // admin attach endpoint uses, for the same reason. A crash between
            // the two leaves a source that is logged but unused, which is
            // harmless; the other order leaves one in use with nothing recording
            // why it was permitted.
            await SourceLicenceDeclarationQueryEngine.record({
                event: SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,
                deckId: provenanceDeckId,
                verificationSourceId: verificationSource.id,
                informationSourceId: resolvedSource.informationSourceId,
                sourceName: resolvedSource.name,
                sourceUrl: resolvedSource.sourceUrl,
                sourceHash: resolvedSource.contentHash,
                mimeType: resolvedSource.mimeType,
                licenceType: resolvedSource.licenceType,
                licenceNote: resolvedSource.licenceNote,
                usageMode: verificationSource.usageMode,
                sourceNote: verificationSource.sourceNote,
                declaredByUserId: actorUserId,
                declaredByEmail: actorEmail || "",
            });

            await PaidDeckVerificationSourceQueryEngine.attach(verificationSource);
            attachedCount++;
        }

        return attachedCount;
    }

    static #allow(resolvedSources)
    {
        return { allowed: true, errorCode: null, detail: null, resolvedSources: resolvedSources };
    }

    static #refuse(errorCode, detail)
    {
        return { allowed: false, errorCode: errorCode, detail: detail, resolvedSources: [] };
    }
}

module.exports = VerificationSourceAdmission;
