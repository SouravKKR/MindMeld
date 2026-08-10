const { sourceLicenceTypes } = require("../../Enumerations/SourceLicenceTypes");
const { sourceUsageModes } = require("../../Enumerations/SourceUsageModes");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * SourceUsageGate — decides whether a declared source may be used to WRITE the
 * content of a paid deck, as opposed to only being checked against afterwards.
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
 * disable the content option for a licence that would fail here, but that is a
 * courtesy so the user is told while choosing; a request that never went through
 * either surface is refused by this class on the way in.
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
     * True when the mode means the source feeds generation.
     *
     * Tolerates undefined and null, which is what every row written before this
     * field existed carries. Those read as VERIFICATION_ONLY — the behaviour
     * they were attached under, and the safe direction to guess in.
     *
     * @param {number|null|undefined} usageMode
     * @return {boolean}
     */
    static isContentUsage(usageMode)
    {
        return Number(usageMode) === sourceUsageModes.CONTENT_AND_VERIFICATION;
    }

    /**
     * Normalises a client-supplied usage mode to a known enumeration value.
     *
     * Anything unrecognised becomes VERIFICATION_ONLY rather than throwing: an
     * unreadable mode is not a request to generate from the document, and
     * failing closed here means a malformed field can only ever narrow what a
     * source is used for.
     *
     * @param {*} usageMode
     * @return {number}
     */
    static normaliseUsageMode(usageMode)
    {
        return SourceUsageGate.isContentUsage(usageMode)
            ? sourceUsageModes.CONTENT_AND_VERIFICATION
            : sourceUsageModes.VERIFICATION_ONLY;
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
