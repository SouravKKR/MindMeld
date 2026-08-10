const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const AgeVerificationConstants = require("../../Constants/AgeVerificationConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const { ageConsentStates } = require("../../Enumerations/AgeConsentStates");

/**
 * AgeVerificationService
 *
 * Server-authoritative source of truth for "may this account's data be
 * processed" under the DPDP Act's treatment of Children — an individual who has
 * not completed 18 years, per the definition the published Privacy Policy
 * already uses.
 *
 * The Policy commits the platform to obtaining verifiable parental consent
 * before processing a Child's Personal Data, and to collecting guardian details
 * in order to do it. Nothing implemented that. This class, the
 * EnsureAgeConsent plugin and the two endpoints that write through it are that
 * commitment in code, so the document and the running system finally agree.
 *
 * The state machine, resolved on every authenticated request:
 *
 *   UNDECLARED                       -> no date of birth on file. Blocked.
 *   ADULT                            -> declared, 18 or over. Allowed.
 *   MINOR_AWAITING_GUARDIAN_CONSENT  -> declared, under 18, no consent. Blocked.
 *   MINOR_CONSENTED                  -> declared, under 18, guardian recorded. Allowed.
 *
 * Three deliberate design decisions:
 *
 *   1. Age is DERIVED from the stored date of birth on every read, never
 *      cached as a boolean. A stored "isAdult" flag is wrong the day the user
 *      turns 18 and stays wrong forever, and it would leave the account
 *      gated behind a consent it no longer needs.
 *
 *   2. Date of birth is write-once (recordDateOfBirth refuses to overwrite).
 *      A minor who can re-declare as an adult has not been age-gated at all,
 *      and the block screen is exactly where the incentive to do so is
 *      highest. Correcting a genuine mistake is deliberately an operator
 *      action, so it leaves a trail.
 *
 *   3. Every field this service owns is reserved against the generic
 *      /UpdateUserAdditionalData merge (isReservedAgeKey), the same defence
 *      LegalAcceptanceService uses. Consent that a client can POST for itself
 *      is not consent.
 *
 * What this deliberately does NOT claim. Recording a guardian's declared
 * details is a consent RECORD, not identity verification — the Policy's
 * "verifiable" standard needs an out-of-band check that no code here performs.
 * The stored record is what makes that check possible later and what evidences
 * the platform asked; treating it as proof of identity would overstate it.
 */
class AgeVerificationService
{
    static #DATE_OF_BIRTH_KEY = "dateOfBirth";
    static #DATE_OF_BIRTH_RECORDED_AT_KEY = "dateOfBirthRecordedAt";
    static #GUARDIAN_CONSENT_KEY = "guardianConsent";

    // Mirrors LegalAcceptanceService's reserved-key defence. Anything this
    // service writes must be unreachable from the generic additionalData merge.
    static #RESERVED_AGE_KEYS = new Set
    ([
        AgeVerificationService.#DATE_OF_BIRTH_KEY,
        AgeVerificationService.#DATE_OF_BIRTH_RECORDED_AT_KEY,
        AgeVerificationService.#GUARDIAN_CONSENT_KEY
    ]);

    static #MILLISECONDS_PER_YEAR_APPROXIMATE = 365.25 * 24 * 60 * 60 * 1000;

    /**
     * Resolves the consent state of an account from what is stored on it.
     *
     * @param {import("../../Model/User")} user
     * @return {{state: number, bProcessingAllowed: boolean, ageYears: number|null}}
     */
    static resolveState(user)
    {
        const additionalData = AgeVerificationService.#readAdditionalData(user);
        const storedDateOfBirth = additionalData[AgeVerificationService.#DATE_OF_BIRTH_KEY];

        const ageYears = AgeVerificationService.computeAgeYears(storedDateOfBirth, Date.now());

        if (ageYears === null)
        {
            return { state: ageConsentStates.UNDECLARED, bProcessingAllowed: false, ageYears: null };
        }

        if (ageYears >= AgeVerificationConstants.AGE_OF_MAJORITY_YEARS)
        {
            return { state: ageConsentStates.ADULT, bProcessingAllowed: true, ageYears: ageYears };
        }

        const guardianConsent = additionalData[AgeVerificationService.#GUARDIAN_CONSENT_KEY];

        if (AgeVerificationService.#isUsableGuardianConsent(guardianConsent))
        {
            return { state: ageConsentStates.MINOR_CONSENTED, bProcessingAllowed: true, ageYears: ageYears };
        }

        return { state: ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT, bProcessingAllowed: false, ageYears: ageYears };
    }

    /**
     * Completed years between a date of birth and a reference instant, or null
     * when the value is missing or unusable.
     *
     * Counts COMPLETED years off the calendar rather than dividing a duration:
     * the Act speaks of an individual who has not completed eighteen years, and
     * a millisecond division gets the birthday wrong in leap years — which for
     * one day would gate an adult or release a minor.
     *
     * @param {string|Date|null} dateOfBirthValue
     * @param {number} nowMilliseconds
     * @return {number|null}
     */
    static computeAgeYears(dateOfBirthValue, nowMilliseconds)
    {
        if (dateOfBirthValue === null || dateOfBirthValue === undefined || dateOfBirthValue === "")
        {
            return null;
        }

        const dateOfBirth = dateOfBirthValue instanceof Date ? dateOfBirthValue : new Date(dateOfBirthValue);

        if (Number.isNaN(dateOfBirth.getTime()))
        {
            return null;
        }

        const referenceDate = new Date(nowMilliseconds);

        if (dateOfBirth.getTime() > referenceDate.getTime())
        {
            return null;
        }

        let completedYears = referenceDate.getUTCFullYear() - dateOfBirth.getUTCFullYear();

        const bBirthdayNotReachedThisYear =
            referenceDate.getUTCMonth() < dateOfBirth.getUTCMonth()
            || (referenceDate.getUTCMonth() === dateOfBirth.getUTCMonth() && referenceDate.getUTCDate() < dateOfBirth.getUTCDate());

        if (bBirthdayNotReachedThisYear)
        {
            completedYears--;
        }

        return completedYears < 0 ? null : completedYears;
    }

    /**
     * Records a date of birth against an account, once.
     *
     * @param {string} userId
     * @param {import("../../Model/User")} user - The stored record, re-read by the caller; never the client's copy.
     * @param {string} dateOfBirthIsoDate - "YYYY-MM-DD" as submitted.
     * @return {Promise<{ok: boolean, reason?: string, state?: number, ageYears?: number, additionalData?: object}>}
     */
    static async recordDateOfBirth(userId, user, dateOfBirthIsoDate)
    {
        if (!userId)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const additionalData = AgeVerificationService.#readAdditionalData(user);

        // Write-once. Re-declaring is the obvious way around the gate, so the
        // second attempt is refused rather than merged.
        if (additionalData[AgeVerificationService.#DATE_OF_BIRTH_KEY])
        {
            return { ok: false, reason: ErrorCodes.DATE_OF_BIRTH_ALREADY_DECLARED };
        }

        const validation = AgeVerificationService.validateDateOfBirth(dateOfBirthIsoDate, Date.now());
        if (!validation.bValid)
        {
            return { ok: false, reason: validation.reason };
        }

        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [AgeVerificationService.#DATE_OF_BIRTH_KEY]: validation.normalizedDateOfBirth,
            [AgeVerificationService.#DATE_OF_BIRTH_RECORDED_AT_KEY]: new Date().toISOString()
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        const bIsAdult = validation.ageYears >= AgeVerificationConstants.AGE_OF_MAJORITY_YEARS;

        return {
            ok: true,
            state: bIsAdult ? ageConsentStates.ADULT : ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT,
            ageYears: validation.ageYears,
            additionalData: updatedAdditionalData
        };
    }

    /**
     * Validates a submitted date of birth without writing anything.
     *
     * The plausibility bounds are not an age gate — they reject typos such as a
     * four-digit year in the future or a 1823 birth date, which would otherwise
     * be stored forever as an unchallengeable declaration.
     *
     * @param {string} dateOfBirthIsoDate
     * @param {number} nowMilliseconds
     * @return {{bValid: boolean, reason: string|null, normalizedDateOfBirth: string|null, ageYears: number|null}}
     */
    static validateDateOfBirth(dateOfBirthIsoDate, nowMilliseconds)
    {
        const rejection = { bValid: false, reason: ErrorCodes.INVALID_DATE_OF_BIRTH, normalizedDateOfBirth: null, ageYears: null };

        if (typeof dateOfBirthIsoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirthIsoDate.trim()))
        {
            return rejection;
        }

        const trimmedDateOfBirth = dateOfBirthIsoDate.trim();
        const parsedDate = new Date(`${trimmedDateOfBirth}T00:00:00.000Z`);

        if (Number.isNaN(parsedDate.getTime()))
        {
            return rejection;
        }

        // Catches the dates the format accepts but the calendar does not, such
        // as 2011-02-31, which Date rolls forward into March rather than
        // rejecting.
        if (parsedDate.toISOString().slice(0, 10) !== trimmedDateOfBirth)
        {
            return rejection;
        }

        const ageYears = AgeVerificationService.computeAgeYears(parsedDate, nowMilliseconds);

        if (ageYears === null
            || ageYears < AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS
            || ageYears > AgeVerificationConstants.MAXIMUM_PLAUSIBLE_AGE_YEARS)
        {
            return rejection;
        }

        return { bValid: true, reason: null, normalizedDateOfBirth: trimmedDateOfBirth, ageYears: ageYears };
    }

    /**
     * Records a guardian's consent for a minor's account.
     *
     * Refused for an account that is not a minor awaiting consent — an adult
     * account carrying a guardian record would be a false entry in the very
     * register the platform would produce as evidence.
     *
     * @param {string} userId
     * @param {import("../../Model/User")} user
     * @param {{guardianName: string, guardianRelationship: string, guardianEmail: string, guardianContactNumber: string}} guardianDetails
     * @return {Promise<{ok: boolean, reason?: string, state?: number, additionalData?: object}>}
     */
    static async recordGuardianConsent(userId, user, guardianDetails)
    {
        if (!userId)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const currentState = AgeVerificationService.resolveState(user);

        if (currentState.state === ageConsentStates.UNDECLARED)
        {
            return { ok: false, reason: ErrorCodes.AGE_DECLARATION_REQUIRED };
        }

        if (currentState.state !== ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT)
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE };
        }

        const normalizedGuardian = AgeVerificationService.normalizeGuardianDetails(guardianDetails);

        if (normalizedGuardian === null)
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_DETAILS_INCOMPLETE };
        }

        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [AgeVerificationService.#GUARDIAN_CONSENT_KEY]: Object.assign({}, normalizedGuardian,
            {
                // Server-stamped, like every other consent timestamp in this
                // codebase. A client-supplied "consented at" is a claim, not a
                // record.
                recordedAt: new Date().toISOString()
            })
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        return { ok: true, state: ageConsentStates.MINOR_CONSENTED, additionalData: updatedAdditionalData };
    }

    /**
     * Trims and length-checks the guardian fields, returning null when any
     * required one is missing or the email is not an email.
     *
     * @param {object} guardianDetails
     * @return {{guardianName: string, guardianRelationship: string, guardianEmail: string, guardianContactNumber: string}|null}
     */
    static normalizeGuardianDetails(guardianDetails)
    {
        if (!guardianDetails || typeof guardianDetails !== "object")
        {
            return null;
        }

        const guardianName = AgeVerificationService.#normalizeField(guardianDetails.guardianName, AgeVerificationConstants.GUARDIAN_NAME_MAXIMUM_LENGTH);
        const guardianRelationship = AgeVerificationService.#normalizeField(guardianDetails.guardianRelationship, AgeVerificationConstants.GUARDIAN_RELATIONSHIP_MAXIMUM_LENGTH);
        const guardianEmail = AgeVerificationService.#normalizeField(guardianDetails.guardianEmail, AgeVerificationConstants.GUARDIAN_EMAIL_MAXIMUM_LENGTH);
        const guardianContactNumber = AgeVerificationService.#normalizeField(guardianDetails.guardianContactNumber, AgeVerificationConstants.GUARDIAN_CONTACT_NUMBER_MAXIMUM_LENGTH);

        if (guardianName === null || guardianRelationship === null || guardianEmail === null || guardianContactNumber === null)
        {
            return null;
        }

        // The guardian's email is the only channel by which the consent can
        // later be confirmed or withdrawn, so an unusable one makes the whole
        // record worthless.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail))
        {
            return null;
        }

        return {
            guardianName: guardianName,
            guardianRelationship: guardianRelationship,
            guardianEmail: guardianEmail,
            guardianContactNumber: guardianContactNumber
        };
    }

    /**
     * True when fieldKey is one of the age/consent fields this service owns, so
     * the generic /UpdateUserAdditionalData merge can refuse client writes to it.
     *
     * @param {string} fieldKey
     * @return {boolean}
     */
    static isReservedAgeKey(fieldKey)
    {
        return typeof fieldKey === "string" && AgeVerificationService.#RESERVED_AGE_KEYS.has(fieldKey);
    }

    static #normalizeField(rawValue, maximumLength)
    {
        if (typeof rawValue !== "string")
        {
            return null;
        }

        const trimmedValue = rawValue.trim();

        if (trimmedValue.length === 0 || trimmedValue.length > maximumLength)
        {
            return null;
        }

        return trimmedValue;
    }

    static #isUsableGuardianConsent(guardianConsent)
    {
        return Boolean(guardianConsent)
            && typeof guardianConsent === "object"
            && typeof guardianConsent.guardianEmail === "string"
            && guardianConsent.guardianEmail.length > 0
            && typeof guardianConsent.recordedAt === "string"
            && guardianConsent.recordedAt.length > 0;
    }

    static #readAdditionalData(user)
    {
        return (user && typeof user.getAdditionalData === "function" && user.getAdditionalData()) || {};
    }
}

module.exports = AgeVerificationService;
