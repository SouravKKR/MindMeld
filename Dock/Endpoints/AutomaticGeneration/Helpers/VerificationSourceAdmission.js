const crypto = require("crypto");
const InformationSourceQueryEngine = require("../../../Globals/Classes/Database/InformationSourceQueryEngine");
const PaidDeckVerificationSourceQueryEngine = require("../../../Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../../../Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const VerificationSourceLicenceGate = require("../../../Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
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
 * THESE ARE NOT GENERATION INPUTS, and the separation is structural rather than
 * conventional: they travel in their own request field, they are never added to
 * informationSources, and they are never seen by validateGenerationSettings or
 * PaidDeckGenerationGate — which continue to accept a curriculum or syllabus and
 * refuse everything else. A verification source that reached the generation
 * source list would make the audit trail's central claim false, so it must stay
 * impossible to confuse the two lists for one another.
 */
class VerificationSourceAdmission
{
    /**
     * Checks the picked sources before the run is allowed to start.
     *
     * Every source must belong to the acting administrator and must already
     * carry a complete licence declaration — the picker only offers sources that
     * do, and this re-checks it server-side against the stored row rather than
     * trusting that.
     *
     * @param {string[]} verificationSourceIds
     * @param {string} actorUserId
     * @return {Promise<{allowed: boolean, errorCode: (string|null), detail: (string|null), resolvedSources: object[]}>}
     */
    static async resolveAndValidate(verificationSourceIds, actorUserId)
    {
        const requestedIds = Array.isArray(verificationSourceIds)
            ? verificationSourceIds.filter(sourceId => typeof sourceId === "string" && sourceId.length > 0)
            : [];

        if (requestedIds.length === 0)
        {
            return VerificationSourceAdmission.#allow([]);
        }

        if (requestedIds.length > PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK)
        {
            return VerificationSourceAdmission.#refuse(
                ErrorCodes.INVALID_REQUEST,
                `A deck can be checked against at most ${PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK} verification sources.`,
            );
        }

        const resolvedSources = [];

        for (const informationSourceId of requestedIds)
        {
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

            resolvedSources.push({
                informationSourceId: informationSource.getId(),
                name: informationSource.getName(),
                contentHash: informationSource.getHash() || "",
                storagePath: `${informationSource.getDirectoryPath()}/${informationSource.getHash()}`,
                mimeType: informationSource.getMimeType() || "",
                sourceUrl: informationSource.getSourceUrl() || "",
                licenceType: informationSource.getLicenceType(),
                licenceNote: informationSource.getLicenceNote() || "",
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
