const { sourceLicenceTypes } = require("../../Enumerations/SourceLicenceTypes");
const ErrorCodes = require("../../Constants/ErrorCodes");

/**
 * VerificationSourceLicenceGate — the server-side check that an admin has
 * actually declared a usable licensing basis before a document becomes a
 * grounding source for a paid deck's verification.
 *
 * WHY THIS IS ON THE SERVER. The refinement flow asks for the same declaration
 * in the browser and validates it only there: ContentRefinementRunner checks
 * that the attached source belongs to the caller and nothing else, so a request
 * that never went through the form records licenceType 0 and the "mandatory
 * declaration" turns out to have been a suggestion. That is survivable for a
 * user correcting their own deck. It is not survivable here, because the output
 * of this pass is used to justify changes to content that is then SOLD, and the
 * declaration is the whole basis on which a third-party document was consulted
 * at all. A control that only exists in the client is not a control.
 *
 * WHAT IT ASKS FOR, AND WHY EACH RULE EXISTS:
 *
 *   - UNSPECIFIED is refused outright. "Not specified" is the absence of a
 *     declaration, and recording it as though it were one would put a real
 *     permissions question mark on the deck while looking, in the audit trail,
 *     exactly like a source that had been cleared.
 *
 *   - OTHER and LICENSED_PERMISSION require a note. Neither names a licence on
 *     its own — one says "something else", the other says "we have permission" —
 *     so without the note they record that someone clicked a dropdown, not what
 *     the basis is. This mirrors the rule the refinement form already applies to
 *     OTHER; LICENSED_PERMISSION is added because "permission held" that cannot
 *     say from whom is the same shrug in a smarter suit.
 *
 *   - CC_BY requires a note or a URL. Attribution is a CONDITION of that
 *     licence, not a courtesy, and it cannot be given if the record does not say
 *     what to attribute. Either field satisfies it: a URL identifies the work, a
 *     note can carry the author's name where no stable URL exists.
 *
 *   - CC0, PUBLIC_DOMAIN and OWN_WORK require neither. They impose no
 *     attribution condition, and demanding busywork for them would train
 *     administrators to type something meaningless into every box.
 *
 * The gate reports WHICH rule refused, so the dialog can say what is missing
 * instead of "invalid".
 */
class VerificationSourceLicenceGate
{
    /**
     * Licences that name themselves and carry no attribution condition.
     */
    static SELF_EVIDENT_LICENCE_TYPES = new Set([
        sourceLicenceTypes.CC0,
        sourceLicenceTypes.PUBLIC_DOMAIN,
        sourceLicenceTypes.OWN_WORK,
    ]);

    /**
     * Licences whose meaning lives entirely in the note beside them.
     */
    static NOTE_REQUIRED_LICENCE_TYPES = new Set([
        sourceLicenceTypes.OTHER,
        sourceLicenceTypes.LICENSED_PERMISSION,
    ]);

    /**
     * Licences that impose an attribution condition, satisfiable by a note or a
     * URL identifying the work.
     */
    static ATTRIBUTION_REQUIRED_LICENCE_TYPES = new Set([
        sourceLicenceTypes.CC_BY,
    ]);

    /**
     * @param {{licenceType: number, licenceNote: string, sourceUrl: string}} declaration
     * @return {{allowed: boolean, errorCode: (string|null), detail: (string|null)}}
     */
    static evaluate(declaration)
    {
        const licenceType = Number(declaration ? declaration.licenceType : undefined);
        const licenceNote = String((declaration && declaration.licenceNote) || "").trim();
        const sourceUrl = String((declaration && declaration.sourceUrl) || "").trim();

        const knownLicenceTypes = Object.values(sourceLicenceTypes);

        if (!Number.isInteger(licenceType) || !knownLicenceTypes.includes(licenceType))
        {
            return VerificationSourceLicenceGate.#refuse(
                ErrorCodes.VERIFICATION_SOURCE_LICENCE_REQUIRED,
                "Choose the licence this source is available under.",
            );
        }

        if (licenceType === sourceLicenceTypes.UNSPECIFIED)
        {
            return VerificationSourceLicenceGate.#refuse(
                ErrorCodes.VERIFICATION_SOURCE_LICENCE_REQUIRED,
                "Choose the licence this source is available under. \"Not specified\" is not a declaration.",
            );
        }

        if (VerificationSourceLicenceGate.NOTE_REQUIRED_LICENCE_TYPES.has(licenceType) && licenceNote.length === 0)
        {
            return VerificationSourceLicenceGate.#refuse(
                ErrorCodes.VERIFICATION_SOURCE_LICENCE_REQUIRED,
                "Describe the basis in the note — this choice does not name a licence on its own.",
            );
        }

        if (VerificationSourceLicenceGate.ATTRIBUTION_REQUIRED_LICENCE_TYPES.has(licenceType)
            && licenceNote.length === 0
            && sourceUrl.length === 0)
        {
            return VerificationSourceLicenceGate.#refuse(
                ErrorCodes.VERIFICATION_SOURCE_ATTRIBUTION_REQUIRED,
                "This licence requires attribution. Give the source URL, or name the author in the note.",
            );
        }

        return { allowed: true, errorCode: null, detail: null };
    }

    static #refuse(errorCode, detail)
    {
        return { allowed: false, errorCode: errorCode, detail: detail };
    }
}

module.exports = VerificationSourceLicenceGate;
