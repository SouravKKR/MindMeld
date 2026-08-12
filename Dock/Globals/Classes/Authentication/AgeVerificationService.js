const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const OtpManager = require("./OtpManager");
const AgeVerificationConstants = require("../../Constants/AgeVerificationConstants");
const ErrorCodes = require("../../Constants/ErrorCodes");
const { ageConsentStates } = require("../../Enumerations/AgeConsentStates");
const { otpPurposes } = require("../../Enumerations/OtpPurposes");

/**
 * AgeVerificationService
 *
 * Server-authoritative source of truth for "may this account's data be
 * processed" under the DPDP Act's treatment of Children — an individual who has
 * not completed 18 years, per the definition the published Privacy Policy
 * already uses.
 *
 * The Policy commits the platform to obtaining verifiable parental consent
 * before processing a Child's Personal Data. This class, the EnsureAgeConsent
 * plugin and the endpoints that write through it are that commitment in code.
 *
 * The state machine, resolved on every authenticated request:
 *
 *   UNDECLARED                       -> no age on file. Blocked.
 *   ADULT                            -> declared, 18 or over. Allowed.
 *   MINOR_AWAITING_GUARDIAN_CONSENT  -> declared, under 18, no CONFIRMED
 *                                       consent. Blocked.
 *   MINOR_CONSENTED                  -> declared, under 18, a guardian confirmed
 *                                       a code sent to their own address. Allowed.
 *
 * WHY AN AGE AND NOT A DATE OF BIRTH. The only question the platform has to
 * answer is which side of eighteen the account holder is on. An exact date of
 * birth answers that, but it also pins the person to a single day — the classic
 * identity-verification element — for a decision that needs a year. Storing the
 * declared age narrows what is held to a one-year window and answers the
 * question just as well, which is what data minimisation asks for.
 *
 * WHY THE DECLARATION IS STILL DATED. A stored age is a fact about the day it
 * was given, and it goes stale exactly like the cached "isAdult" boolean this
 * class has always refused to keep: a 17 recorded today means 18 next year, and
 * an account frozen at 17 would stay gated behind a consent it no longer needs.
 * So the pair (declaredAgeYears, ageDeclaredAt) is stored and the CURRENT age is
 * derived from it on every read. Nothing anywhere caches the answer.
 *
 * Legacy rows carry `dateOfBirth` from before this changed and are still read;
 * see #resolveAgeYears. They are not migrated — a derived reading of a date
 * already on file is exact, and rewriting it into a coarser value would destroy
 * information to no benefit while touching every existing account.
 *
 * Other deliberate design decisions:
 *
 *   1. The declaration is write-once (recordDeclaredAge refuses to overwrite).
 *      A minor who can re-declare as an adult has not been age-gated at all,
 *      and the block screen is exactly where the incentive to do so is
 *      highest. Correcting a genuine mistake is deliberately an operator
 *      action, so it leaves a trail.
 *
 *   2. Guardian consent is recorded in TWO stages and only the second one
 *      unblocks anything — see recordPendingGuardianDetails / confirmGuardianConsent.
 *
 *   3. Every field this service owns is reserved against the generic
 *      /UpdateUserAdditionalData merge (isReservedAgeKey), the same defence
 *      LegalAcceptanceService uses. Consent that a client can POST for itself
 *      is not consent.
 */
class AgeVerificationService
{
    static #DECLARED_AGE_YEARS_KEY = "declaredAgeYears";
    static #AGE_DECLARED_AT_KEY = "ageDeclaredAt";
    static #GUARDIAN_CONSENT_KEY = "guardianConsent";
    static #GUARDIAN_CONSENT_PENDING_KEY = "guardianConsentPending";

    // Written by the date-of-birth flow this class used to expose. Still READ so
    // accounts that declared before the change keep working; never written.
    static #LEGACY_DATE_OF_BIRTH_KEY = "dateOfBirth";

    // Mirrors LegalAcceptanceService's reserved-key defence. Anything this
    // service writes must be unreachable from the generic additionalData merge —
    // and the legacy date of birth is reserved too, so a client cannot plant one
    // to override its own declared age in #resolveAgeYears.
    static #RESERVED_AGE_KEYS = new Set
    ([
        AgeVerificationService.#DECLARED_AGE_YEARS_KEY,
        AgeVerificationService.#AGE_DECLARED_AT_KEY,
        AgeVerificationService.#GUARDIAN_CONSENT_KEY,
        AgeVerificationService.#GUARDIAN_CONSENT_PENDING_KEY,
        AgeVerificationService.#LEGACY_DATE_OF_BIRTH_KEY,
        "dateOfBirthRecordedAt"
    ]);

    /**
     * Resolves the consent state of an account from what is stored on it.
     *
     * @param {import("../../Model/User")} user
     * @return {{state: number, bProcessingAllowed: boolean, ageYears: number|null}}
     */
    static resolveState(user)
    {
        const additionalData = AgeVerificationService.#readAdditionalData(user);
        const ageYears = AgeVerificationService.#resolveAgeYears(additionalData, Date.now());

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
     * The account holder's age NOW, from whichever declaration the record
     * carries, or null when it carries neither.
     *
     * The legacy date of birth is preferred when present because it is the more
     * precise of the two — an account that declared one should not be re-read at
     * lower resolution just because the newer field exists.
     *
     * @param {object} additionalData
     * @param {number} nowMilliseconds
     * @return {number|null}
     */
    static #resolveAgeYears(additionalData, nowMilliseconds)
    {
        const legacyDateOfBirth = additionalData[AgeVerificationService.#LEGACY_DATE_OF_BIRTH_KEY];

        if (legacyDateOfBirth)
        {
            return AgeVerificationService.computeAgeYearsFromDateOfBirth(legacyDateOfBirth, nowMilliseconds);
        }

        return AgeVerificationService.computeCurrentAgeYears(
            additionalData[AgeVerificationService.#DECLARED_AGE_YEARS_KEY],
            additionalData[AgeVerificationService.#AGE_DECLARED_AT_KEY],
            nowMilliseconds
        );
    }

    /**
     * Ages a declaration forward to the present.
     *
     * Counts COMPLETED years since the declaration and adds them, so somebody
     * who said 17 eleven months ago is still 17, and is 18 a month later without
     * anything having been rewritten.
     *
     * This is deliberately the WORST CASE for the account holder and the safest
     * for the platform: a declaration of 17 could have been made the day before
     * an eighteenth birthday or the day after a seventeenth, and this treats it
     * as the latter. The error is at most a year and always in the direction of
     * keeping a child gated slightly too long rather than releasing one early.
     *
     * @param {number} declaredAgeYears
     * @param {string|Date|null} declaredAtValue
     * @param {number} nowMilliseconds
     * @return {number|null}
     */
    static computeCurrentAgeYears(declaredAgeYears, declaredAtValue, nowMilliseconds)
    {
        // The typeof guard is load-bearing rather than defensive clutter, and
        // for the same reason it is in validateDeclaredAge: Number() is lenient
        // in ways stored documents reach. Number(null) is 0, Number(true) is 1,
        // Number([14]) is 14 — so without it, a row carrying a null age would
        // read as a newborn rather than as no declaration at all.
        if (typeof declaredAgeYears !== "number" && typeof declaredAgeYears !== "string")
        {
            return null;
        }

        if (typeof declaredAgeYears === "string" && !/^\d{1,3}$/.test(declaredAgeYears.trim()))
        {
            return null;
        }

        const declaredAge = Number(declaredAgeYears);

        if (!Number.isInteger(declaredAge) || declaredAge < 0)
        {
            return null;
        }

        if (declaredAtValue === null || declaredAtValue === undefined || declaredAtValue === "")
        {
            return null;
        }

        const declaredAt = declaredAtValue instanceof Date ? declaredAtValue : new Date(declaredAtValue);

        if (Number.isNaN(declaredAt.getTime()))
        {
            return null;
        }

        const referenceDate = new Date(nowMilliseconds);

        // A declaration stamped in the future is unusable rather than negative —
        // it can only come from a clock problem, and treating it as "no
        // declaration" blocks the account rather than guessing at an age.
        if (declaredAt.getTime() > referenceDate.getTime())
        {
            return null;
        }

        let elapsedYears = referenceDate.getUTCFullYear() - declaredAt.getUTCFullYear();

        const bAnniversaryNotReachedThisYear =
            referenceDate.getUTCMonth() < declaredAt.getUTCMonth()
            || (referenceDate.getUTCMonth() === declaredAt.getUTCMonth() && referenceDate.getUTCDate() < declaredAt.getUTCDate());

        if (bAnniversaryNotReachedThisYear)
        {
            elapsedYears--;
        }

        return declaredAge + Math.max(0, elapsedYears);
    }

    /**
     * Completed years between a date of birth and a reference instant, or null
     * when the value is missing or unusable. Retained for the legacy rows
     * described on the class.
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
    static computeAgeYearsFromDateOfBirth(dateOfBirthValue, nowMilliseconds)
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
     * Records a declared age against an account, once.
     *
     * @param {string} userId
     * @param {import("../../Model/User")} user - The stored record, re-read by the caller; never the client's copy.
     * @param {number|string} submittedAgeYears
     * @return {Promise<{ok: boolean, reason?: string, state?: number, ageYears?: number, additionalData?: object}>}
     */
    static async recordDeclaredAge(userId, user, submittedAgeYears)
    {
        if (!userId)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const additionalData = AgeVerificationService.#readAdditionalData(user);

        // Write-once, against EITHER declaration. Re-declaring is the obvious way
        // around the gate, and a legacy account with a date of birth on file has
        // already answered — letting it also declare an age would give it a second
        // answer that #resolveAgeYears would then have to choose between.
        if (additionalData[AgeVerificationService.#DECLARED_AGE_YEARS_KEY] !== undefined
            && additionalData[AgeVerificationService.#DECLARED_AGE_YEARS_KEY] !== null)
        {
            return { ok: false, reason: ErrorCodes.AGE_ALREADY_DECLARED };
        }

        if (additionalData[AgeVerificationService.#LEGACY_DATE_OF_BIRTH_KEY])
        {
            return { ok: false, reason: ErrorCodes.AGE_ALREADY_DECLARED };
        }

        const validation = AgeVerificationService.validateDeclaredAge(submittedAgeYears);
        if (!validation.bValid)
        {
            return { ok: false, reason: validation.reason };
        }

        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [AgeVerificationService.#DECLARED_AGE_YEARS_KEY]: validation.normalizedAgeYears,
            // Server-stamped. The whole derivation rests on this instant, so a
            // client-supplied one would let an account choose how fast it ages.
            [AgeVerificationService.#AGE_DECLARED_AT_KEY]: new Date().toISOString()
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        const bIsAdult = validation.normalizedAgeYears >= AgeVerificationConstants.AGE_OF_MAJORITY_YEARS;

        return {
            ok: true,
            state: bIsAdult ? ageConsentStates.ADULT : ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT,
            ageYears: validation.normalizedAgeYears,
            additionalData: updatedAdditionalData
        };
    }

    /**
     * Validates a submitted age without writing anything.
     *
     * The plausibility bounds are not an age gate — they reject a typo or a
     * junk value that would otherwise be stored forever as an unchallengeable
     * declaration.
     *
     * @param {number|string} submittedAgeYears
     * @return {{bValid: boolean, reason: string|null, normalizedAgeYears: number|null}}
     */
    static validateDeclaredAge(submittedAgeYears)
    {
        const rejection = { bValid: false, reason: ErrorCodes.INVALID_AGE, normalizedAgeYears: null };

        // Only a number, or a string that is wholly a number, is considered.
        // Number() is lenient in ways JSON bodies reach — Number(true) is 1,
        // Number([17]) is 17 — and an age coerced out of a boolean is not a
        // declaration anybody made.
        if (typeof submittedAgeYears !== "number" && typeof submittedAgeYears !== "string")
        {
            return rejection;
        }

        if (typeof submittedAgeYears === "string" && !/^\d{1,3}$/.test(submittedAgeYears.trim()))
        {
            return rejection;
        }

        const ageYears = Number(submittedAgeYears);

        if (!Number.isInteger(ageYears)
            || ageYears < AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS
            || ageYears > AgeVerificationConstants.MAXIMUM_PLAUSIBLE_AGE_YEARS)
        {
            return rejection;
        }

        return { bValid: true, reason: null, normalizedAgeYears: ageYears };
    }

    /**
     * STAGE ONE of guardian consent: stores the declared guardian details as
     * PENDING and emails that address a code.
     *
     * Pending is deliberately a separate field from the confirmed record, and
     * resolveState reads only the confirmed one. That is the entire security
     * property of this flow: the details a child types in unblock nothing on
     * their own, no matter how many times they are submitted, because the only
     * write that reaches `guardianConsent` is the one that follows a code the
     * guardian's inbox received.
     *
     * Re-requesting overwrites the pending record, so a mistyped address can be
     * corrected. OtpManager's own per-(email, purpose) cooldown bounds how often
     * a code is actually sent.
     *
     * @param {string} userId
     * @param {import("../../Model/User")} user
     * @param {{guardianName: string, guardianRelationship: string, guardianEmail: string, guardianContactNumber: string}} guardianDetails
     * @return {Promise<{ok: boolean, reason?: string, retryAfterSeconds?: number, guardianEmail?: string}>}
     */
    static async recordPendingGuardianDetails(userId, user, guardianDetails)
    {
        if (!userId)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const eligibility = AgeVerificationService.#requireAwaitingConsent(user);
        if (!eligibility.ok)
        {
            return eligibility;
        }

        const normalizedGuardian = AgeVerificationService.normalizeGuardianDetails(guardianDetails);

        if (normalizedGuardian === null)
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_DETAILS_INCOMPLETE };
        }

        // The one check that costs nothing and removes the laziest bypass. A
        // child who nominates their own address is not producing a guardian; the
        // code would land back in the same inbox and the whole flow would confirm
        // only that they can read their own mail.
        const accountEmail = AgeVerificationService.#readAccountEmail(user);
        if (accountEmail.length > 0 && accountEmail === normalizedGuardian.guardianEmail.toLowerCase())
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_EMAIL_SAME_AS_ACCOUNT };
        }

        const otpResult = await OtpManager.requestOtp(
            normalizedGuardian.guardianEmail,
            otpPurposes.GUARDIAN_CONSENT_VERIFICATION,
            { childDisplayName: AgeVerificationService.#readDisplayName(user) }
        );

        if (!otpResult.ok)
        {
            return { ok: false, reason: otpResult.reason, retryAfterSeconds: otpResult.retryAfterSeconds };
        }

        // Written only AFTER the code is away. Storing the pending details first
        // would leave a record claiming a guardian was contacted when the send
        // had failed, and the next stage would then be waiting on a code that was
        // never delivered.
        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [AgeVerificationService.#GUARDIAN_CONSENT_PENDING_KEY]: Object.assign({}, normalizedGuardian,
            {
                requestedAt: new Date().toISOString()
            })
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        return {
            ok: true,
            retryAfterSeconds: otpResult.retryAfterSeconds,
            guardianEmail: normalizedGuardian.guardianEmail
        };
    }

    /**
     * STAGE TWO: checks the code against the PENDING address and, on success,
     * promotes the pending details to the confirmed consent record.
     *
     * The address the code is verified against comes from the stored pending
     * record, never from the request. Taking it from the body would let a caller
     * verify a code issued for one address and have the consent recorded against
     * another.
     *
     * @param {string} userId
     * @param {import("../../Model/User")} user
     * @param {string} submittedCode
     * @return {Promise<{ok: boolean, reason?: string, attemptsRemaining?: number, state?: number, additionalData?: object}>}
     */
    static async confirmGuardianConsent(userId, user, submittedCode)
    {
        if (!userId)
        {
            return { ok: false, reason: ErrorCodes.INVALID_REQUEST };
        }

        const eligibility = AgeVerificationService.#requireAwaitingConsent(user);
        if (!eligibility.ok)
        {
            return eligibility;
        }

        const additionalData = AgeVerificationService.#readAdditionalData(user);
        const pendingGuardian = additionalData[AgeVerificationService.#GUARDIAN_CONSENT_PENDING_KEY];

        if (!pendingGuardian || typeof pendingGuardian.guardianEmail !== "string" || pendingGuardian.guardianEmail.length === 0)
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_CONSENT_CODE_NOT_REQUESTED };
        }

        const verificationResult = await OtpManager.verifyOtp(
            pendingGuardian.guardianEmail,
            submittedCode,
            otpPurposes.GUARDIAN_CONSENT_VERIFICATION
        );

        if (!verificationResult.ok)
        {
            return {
                ok: false,
                reason: verificationResult.reason,
                attemptsRemaining: verificationResult.attemptsRemaining
            };
        }

        const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(userId,
        {
            [AgeVerificationService.#GUARDIAN_CONSENT_KEY]:
            {
                guardianName: pendingGuardian.guardianName,
                guardianRelationship: pendingGuardian.guardianRelationship,
                guardianEmail: pendingGuardian.guardianEmail,
                guardianContactNumber: pendingGuardian.guardianContactNumber,
                // Server-stamped, like every other consent timestamp in this
                // codebase. A client-supplied "consented at" is a claim, not a
                // record.
                recordedAt: new Date().toISOString(),
                // What was actually proven, named rather than implied: somebody
                // reading that inbox supplied a code sent to it. Written as the
                // method rather than as a bare `verified: true` so a later
                // stronger check can be told apart from this one in the evidence.
                verificationMethod: "EMAIL_CODE"
            },
            // The pending record has served its purpose and is cleared, so a
            // stale address can never be promoted a second time.
            [AgeVerificationService.#GUARDIAN_CONSENT_PENDING_KEY]: null
        });

        if (!updatedAdditionalData)
        {
            return { ok: false, reason: ErrorCodes.PERSIST_FAILED };
        }

        return {
            ok: true,
            state: ageConsentStates.MINOR_CONSENTED,
            additionalData: updatedAdditionalData
        };
    }

    /**
     * The shared eligibility test for both guardian stages: the account must be
     * a minor who has not already been consented for.
     *
     * Refused for anyone else — an adult account carrying a guardian record
     * would be a false entry in the very register the platform would produce as
     * evidence.
     *
     * @param {import("../../Model/User")} user
     * @return {{ok: boolean, reason?: string}}
     */
    static #requireAwaitingConsent(user)
    {
        const currentState = AgeVerificationService.resolveState(user);

        if (currentState.state === ageConsentStates.UNDECLARED)
        {
            return { ok: false, reason: ErrorCodes.AGE_DECLARATION_REQUIRED };
        }

        if (currentState.state !== ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT)
        {
            return { ok: false, reason: ErrorCodes.GUARDIAN_CONSENT_NOT_APPLICABLE };
        }

        return { ok: true };
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

        // The guardian's email is the channel the consent is obtained through
        // and the only one by which it can later be withdrawn, so an unusable
        // one makes the whole record worthless.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail))
        {
            return null;
        }

        return {
            guardianName: guardianName,
            guardianRelationship: guardianRelationship,
            // Lower-cased here so the address stored, the address the code is
            // sent to and the address it is verified against are one value.
            // OtpManager normalises its own key the same way; if this did not
            // match, a guardian typing a capital letter would be sent a code
            // filed under an address the confirm step would never look up.
            guardianEmail: guardianEmail.toLowerCase(),
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

    /**
     * A consent record counts only when it names the address it was confirmed
     * through AND carries the server's stamp that the confirmation happened.
     * A pending record has neither, which is what keeps it inert.
     */
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

    static #readAccountEmail(user)
    {
        const additionalData = AgeVerificationService.#readAdditionalData(user);
        const email = additionalData.email;
        return typeof email === "string" ? email.trim().toLowerCase() : "";
    }

    static #readDisplayName(user)
    {
        if (!user || typeof user.getDisplayName !== "function")
        {
            return "";
        }

        const displayName = user.getDisplayName();
        return typeof displayName === "string" ? displayName.trim() : "";
    }
}

module.exports = AgeVerificationService;
