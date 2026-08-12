const { sourceLicenceTypes } = require("../../Enumerations/SourceLicenceTypes");
const { sourceUsageModes } = require("../../Enumerations/SourceUsageModes");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * SourceUsageGate — decides what a declared source may be used for: writing the
 * content of a paid deck, checking the finished deck against it, or both.
 *
 * THESE ARE TWO INDEPENDENT AXES, NOT ONE SWITCH. A source is content-bearing or
 * it is not; separately, it is checked against or it is not. Three of the four
 * combinations are offered — the fourth, neither, is a source with no reason to
 * be attached — and each stage of the pipeline reads exactly the axis that
 * concerns it. `isContentUsage` answers the first question, `isVerificationUsage`
 * the second, and no caller is allowed to derive one from the other: a source
 * that writes a chapter is often a poor yardstick to then mark that chapter
 * against, which is the whole reason CONTENT_ONLY exists.
 *
 * WHY THIS IS A SEPARATE GATE FROM VerificationSourceLicenceGate. That gate asks
 * "is this declaration complete?" — has a licence been named, and does it carry
 * whatever the licence itself demands. This one asks a different and stricter
 * question: "does the declared licence actually permit us to write new, sellable
 * material from this document?" A complete declaration is a precondition for
 * that question, not an answer to it. Two examples make the gap concrete:
 *
 *   - OTHER with a note is a COMPLETE declaration — the note says what the basis
 *     is — and it is perfectly good for verification, where the document is only
 *     read and compared. It is not good enough to generate sellable content
 *     from, because "other, see note" is free text: nothing in the record
 *     commits to the derivative right actually having been granted, and the
 *     party relying on it later would be reading prose rather than a licence.
 *
 *   - UNSPECIFIED is refused here as well as there. That is deliberate
 *     duplication, not an oversight: a gate whose correctness depends on another
 *     gate having run first is not a gate. Both call sites must be safe alone.
 *
 * WHY EACH LICENCE SITS WHERE IT DOES:
 *
 *   - OWN_WORK — the material is the declarer's. Nobody else's right is engaged.
 *   - LICENSED_PERMISSION — the declarer states a licence was obtained, and the
 *     mandatory note records from whom. That is the evidenced-permission case
 *     this whole feature exists to support.
 *   - CC0 and PUBLIC_DOMAIN — no rights reserved, derivative use included.
 *   - CC_BY — expressly permits derivative works, on the single condition of
 *     attribution, which the licence gate has already required as a note or URL.
 *   - OTHER — see above. Refused for content, allowed for verification.
 *   - UNSPECIFIED — the absence of a declaration. Refused for everything.
 *
 * The gate is authoritative. The generation page and the admin dialog both
 * disable the content options for a licence that would fail here, but that is a
 * courtesy so the user is told while choosing; a request that never went through
 * either surface is refused by this class on the way in.
 *
 * The licence question is asked of CONTENT_ONLY exactly as it is asked of
 * CONTENT_AND_VERIFICATION. Declining to check the deck against a document does
 * not lessen the right engaged by writing the deck from it — if anything that is
 * the mode where derivation is least observable afterwards.
 */
class SourceUsageGate
{
    /**
     * The licences under which a source may be used to WRITE content, not only
     * to check it. Every one either reserves no rights, or expressly grants the
     * derivative right, or records a permission obtained from the rights holder.
     */
    static DERIVATIVE_PERMITTING_LICENCE_TYPES = new Set([
        sourceLicenceTypes.CC0,
        sourceLicenceTypes.PUBLIC_DOMAIN,
        sourceLicenceTypes.CC_BY,
        sourceLicenceTypes.OWN_WORK,
        sourceLicenceTypes.LICENSED_PERMISSION,
    ]);

    /**
     * The modes under which the pipeline may WRITE from the document.
     *
     * Both of them engage the same right and are therefore held to the same
     * licence rule by evaluate() below. What separates them is only what happens
     * to the document AFTERWARDS, which is a question for isVerificationUsage.
     */
    static CONTENT_BEARING_USAGE_MODES = new Set([
        sourceUsageModes.CONTENT_AND_VERIFICATION,
        sourceUsageModes.CONTENT_ONLY,
    ]);

    /**
     * Normalises a client-supplied usage mode to a known enumeration value.
     *
     * Anything unrecognised becomes VERIFICATION_ONLY rather than throwing: an
     * unreadable mode is not a request to generate from the document, and
     * failing closed here means a malformed field can only ever narrow what a
     * source is used for.
     *
     * THE typeof GUARD IS LOAD-BEARING, not defensive clutter. Number() is
     * lenient in ways JSON bodies reach: Number(true) is 1, Number([1]) is 1,
     * Number(" 1 ") is 1. Without the guard a body carrying `"usageMode": true`
     * coerces to a content mode — a silent promotion, which is the one outcome
     * this class exists to make impossible. Only a number, or a string that is
     * wholly a number, is even considered.
     *
     * @param {*} usageMode
     * @return {number}
     */
    static normaliseUsageMode(usageMode)
    {
        if (typeof usageMode !== "number" && typeof usageMode !== "string")
        {
            return sourceUsageModes.VERIFICATION_ONLY;
        }

        if (typeof usageMode === "string" && usageMode.trim().length === 0)
        {
            return sourceUsageModes.VERIFICATION_ONLY;
        }

        const numericUsageMode = Number(usageMode);

        if (!Number.isInteger(numericUsageMode) || !Object.values(sourceUsageModes).includes(numericUsageMode))
        {
            return sourceUsageModes.VERIFICATION_ONLY;
        }

        return numericUsageMode;
    }

    /**
     * True when the mode means the source feeds generation.
     *
     * Tolerates undefined and null, which is what every row written before this
     * field existed carries. Those read as VERIFICATION_ONLY — the behaviour
     * they were attached under, and the safe direction to guess in.
     *
     * Asked of the NORMALISED value, so an unreadable mode can never arrive here
     * as content by way of a lenient coercion.
     *
     * @param {number|null|undefined} usageMode
     * @return {boolean}
     */
    static isContentUsage(usageMode)
    {
        return SourceUsageGate.CONTENT_BEARING_USAGE_MODES.has(SourceUsageGate.normaliseUsageMode(usageMode));
    }

    /**
     * True when the mode means the finished deck is CHECKED AGAINST the source.
     *
     * The asymmetry with isContentUsage is the safety property of this pair, and
     * it is deliberate in both directions. An absent or unreadable mode is not
     * content — guessing otherwise would generate sellable material from a
     * document on the strength of a malformed field — but it IS verification,
     * because that is what every row written before this field existed was
     * attached to do, and because the failure it causes (a deck checked against
     * one document more than intended) is the harmless one.
     *
     * @param {number|null|undefined} usageMode
     * @return {boolean}
     */
    static isVerificationUsage(usageMode)
    {
        return SourceUsageGate.normaliseUsageMode(usageMode) !== sourceUsageModes.CONTENT_ONLY;
    }

    /**
     * The subset the pipeline may WRITE from.
     *
     * @param {object[]} sources
     * @return {object[]}
     */
    static selectContentSources(sources)
    {
        if (!Array.isArray(sources))
        {
            return [];
        }

        return sources.filter(source => SourceUsageGate.isContentUsage(source ? source.usageMode : undefined));
    }

    /**
     * The subset a verification pass may CHECK AGAINST.
     *
     * Lives beside its counterpart rather than being written inline at each call
     * site, because "attached" and "checked against" stopped being the same set
     * the moment CONTENT_ONLY existed, and three separate places had been
     * relying on them being the same.
     *
     * @param {object[]} sources
     * @return {object[]}
     */
    static selectVerificationSources(sources)
    {
        if (!Array.isArray(sources))
        {
            return [];
        }

        return sources.filter(source => SourceUsageGate.isVerificationUsage(source ? source.usageMode : undefined));
    }

    /**
     * @param {{licenceType: number, usageMode: number}} usageDeclaration
     * @return {{allowed: boolean, errorCode: (string|null), detail: (string|null)}}
     */
    static evaluate(usageDeclaration)
    {
        const usageMode = Number(usageDeclaration ? usageDeclaration.usageMode : undefined);
        const licenceType = Number(usageDeclaration ? usageDeclaration.licenceType : undefined);

        const knownUsageModes = Object.values(sourceUsageModes);

        if (!Number.isInteger(usageMode) || !knownUsageModes.includes(usageMode))
        {
            return SourceUsageGate.#refuse(
                ErrorCodes.SOURCE_USAGE_MODE_INVALID,
                "Choose whether this source is used only to check the deck, or also to write it.",
            );
        }

        // Verification-only is what every source could already do, under any
        // complete declaration. Nothing further to ask.
        //
        // EVERY OTHER MODE FALLS THROUGH TO THE LICENCE CHECK, and the check is
        // written that way round on purpose. Listing the content-bearing modes
        // here instead would mean a mode added later is permitted by default
        // until somebody remembers to add it to the list; this way a mode nobody
        // has thought about yet is refused until its licence is declared.
        if (usageMode === sourceUsageModes.VERIFICATION_ONLY)
        {
            return { allowed: true, errorCode: null, detail: null };
        }

        if (licenceType === sourceLicenceTypes.UNSPECIFIED
            || !Number.isInteger(licenceType)
            || !Object.values(sourceLicenceTypes).includes(licenceType))
        {
            return SourceUsageGate.#refuse(
                ErrorCodes.SOURCE_USAGE_NOT_PERMITTED_BY_LICENCE,
                "Declare the licence before using this source to write deck content.",
            );
        }

        if (!SourceUsageGate.DERIVATIVE_PERMITTING_LICENCE_TYPES.has(licenceType))
        {
            return SourceUsageGate.#refuse(
                ErrorCodes.SOURCE_USAGE_NOT_PERMITTED_BY_LICENCE,
                "This licence does not record a right to create new material from the source, so it can only be "
                + "used to check the deck. To write content from it, declare the specific licence or permission "
                + "you hold — \"Licensed permission\" with a note naming who granted it, or the licence itself.",
            );
        }

        return { allowed: true, errorCode: null, detail: null };
    }

    static #refuse(errorCode, detail)
    {
        return { allowed: false, errorCode: errorCode, detail: detail };
    }
}

module.exports = SourceUsageGate;
