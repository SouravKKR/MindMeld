const { userRoles } = require("../../Enumerations/UserRoles");
const { informationSourceTypes } = require("../../Enumerations/InformationSourceTypes");
const { curriculumPlausibility } = require("../../Enumerations/CurriculumPlausibility");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * PaidDeckGenerationGate
 *
 * The Phase 0 admission check for the admin-only "Paid deck" generation mode.
 *
 * Why this is a structural gate rather than a policy note. Content the platform
 * SELLS is first-party commercial material with no intermediary to absorb a
 * licensing question — the legal position rests entirely on independent
 * creation. Facts and curricula are not copyrightable, so content written from
 * model knowledge against a public syllabus is original expression. That
 * argument only holds if the pipeline demonstrably never had a textbook to work
 * from, which is what this class enforces.
 *
 * It takes two signals to enforce that, because neither is sufficient alone:
 *
 *   1. The DECLARED type must be CURRICULUM_OR_SYLLABUS. This is chosen per run
 *      on the generation page, not fixed at upload — the same PDF is legitimately
 *      a curriculum in one run and reference material in the next, and every file
 *      lands in storage as a provided document regardless.
 *   2. The MEASURED shape must not contradict it. Because the declaration is the
 *      user's, on its own it would make this gate self-certifying. OcrPdf measures
 *      every uploaded document's structure and stores the verdict, and an explicit
 *      IMPLAUSIBLE overrides the declaration here.
 *
 * Both checks run server-side against stored state. Hiding a checkbox and
 * filtering a dropdown are UX, not constraints — a crafted request would sail
 * straight past them.
 */
class PaidDeckGenerationGate
{
    /**
     * The only information-source type paid-deck mode will accept. Everything
     * else — uploaded documents above all, but also arbitrary web sources and
     * past question papers — is refused, because each is a route by which
     * third-party expression could reach content that is later sold.
     */
    static ALLOWED_SOURCE_TYPE = informationSourceTypes.CURRICULUM_OR_SYLLABUS;

    /**
     * Returns true when the request asked for paid-deck mode. Tolerates a null
     * settings object so callers do not have to guard.
     *
     * @param {GeneralGenerationSettings|null} generalGenerationSettings
     * @return {boolean}
     */
    static isRequested(generalGenerationSettings)
    {
        if (!generalGenerationSettings || typeof generalGenerationSettings.getPaidDeckMode !== "function")
        {
            return false;
        }
        return generalGenerationSettings.getPaidDeckMode() === true;
    }

    /**
     * Re-authorises the mode against the STORED user record, exactly the way the
     * /Admin/* routes do. The client's claim to be an admin is never trusted;
     * the role is read off the user object Dock loaded from Mongo for this
     * session.
     *
     * @param {User|null} user The authenticated user, as loaded server-side.
     * @return {{allowed: boolean, reason: (string|null)}}
     */
    static authorize(user)
    {
        if (!user || typeof user.getRole !== "function" || user.getRole() !== userRoles.ADMIN)
        {
            return { allowed: false, reason: ErrorCodes.PAID_DECK_MODE_REQUIRES_ADMIN };
        }
        return { allowed: true, reason: null };
    }

    /**
     * Enforces the source restriction. Throws (rather than returning a flag) so
     * it composes with validateGenerationSettings, whose whole contract is
     * "throws with a user-readable message on the first violation".
     *
     * A run with no sources at all is also refused: the description-only path
     * auto-enables web and AI sources downstream, which would reintroduce
     * arbitrary third-party text into content that gets sold.
     *
     * @param {ExtractableInformationSource[]} informationSources
     * @throws {Error} When any source is of a type paid-deck mode does not accept.
     */
    static validateSourceTypes(informationSources)
    {
        const sources = informationSources || [];

        if (sources.length === 0)
        {
            throw new Error(
                "Paid deck mode needs at least one curriculum/syllabus source. "
                + "Generating from a description alone would fall back to open web sources, "
                + "which is exactly what this mode exists to prevent."
            );
        }

        for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++)
        {
            const informationSource = sources[sourceIndex].getInformationSource();
            const sourceType = informationSource ? informationSource.getSourceType() : null;

            if (sourceType !== PaidDeckGenerationGate.ALLOWED_SOURCE_TYPE)
            {
                throw new Error(
                    `Information source #${sourceIndex + 1}: paid deck mode accepts only `
                    + `curriculum/syllabus sources. Set this source's type to Curriculum Or Syllabus, `
                    + `or remove it, so that content offered for sale is written from the curriculum `
                    + `rather than from someone else's material.`
                );
            }

            // The type above is a DECLARATION — the user picks it per run on the
            // generation page, and that is deliberate: the same PDF is a
            // curriculum in one run and reference material in the next. But a
            // declaration alone would make this gate self-certifying, so it is
            // checked against the structural measurement OcrPdf recorded on the
            // document at upload (page count + line-length distribution; no model,
            // so the verdict is stable and explainable).
            //
            // Only an explicit IMPLAUSIBLE refuses. UNKNOWN covers sources
            // uploaded before the measurement existed and documents the check
            // declined to judge — treating those as failures would retroactively
            // break every source already in the library.
            if (informationSource
                && typeof informationSource.getCurriculumPlausibility === "function"
                && informationSource.getCurriculumPlausibility() === curriculumPlausibility.IMPLAUSIBLE)
            {
                const measuredReason = typeof informationSource.getCurriculumPlausibilityReason === "function"
                    ? (informationSource.getCurriculumPlausibilityReason() || "")
                    : "";

                throw new Error(
                    `Information source #${sourceIndex + 1} does not read as a curriculum or syllabus`
                    + `${measuredReason.length > 0 ? `: ${measuredReason}` : "."}`
                    + ` Paid deck content must be written from a curriculum rather than from someone `
                    + `else's material, so a document with the shape of a textbook can't be used here — `
                    + `even when it is labelled as a curriculum. It can still be used for your own `
                    + `(non-paid) generations.`
                );
            }
        }
    }

    /**
     * Image sources are the second way a PDF reaches the pipeline — PrepareImages
     * extracts figures straight out of them. Paid-deck mode generates its own
     * visuals, so it must run with none.
     *
     * This DROPS them rather than rejecting the request, and the distinction
     * matters. An image source here is almost never a deliberate choice: the
     * generation page mirrors the information sources into the image sources
     * whenever "inherit image sources" is on, which is the default, so the
     * mode's own default UI state produces one. Rejecting made paid-deck mode
     * unusable without the user being able to see why — the offending value was
     * one they never set.
     *
     * Dropping is not a silent acceptance of user input. The guarantee the mode
     * needs is "no figure was extracted from an uploaded document", and clearing
     * the list delivers exactly that, with certainty, at the one point every
     * run passes through. The caller logs what it dropped.
     *
     * @param {ExtractableInformationSource[]} imageSources
     * @return {{imageSources: ExtractableInformationSource[], droppedCount: number}}
     */
    static stripImageSources(imageSources)
    {
        const sources = imageSources || [];
        return { imageSources: [], droppedCount: sources.length };
    }
}

module.exports = PaidDeckGenerationGate;
