import UserIdentityManager from "./UserIdentityManager.js";
import { ageConsentStates } from "../Enumerations/AgeConsentStates.js";
import AgeVerificationConstants from "../Constants/AgeVerificationConstants.js";

/**
 * AgeVerificationManager
 *
 * Owns the post-login age flow: collect a date of birth, and where that date
 * makes the account holder a Child (under 18, the definition the Privacy Policy
 * uses), collect a parent's or guardian's consent before the account may be
 * used.
 *
 * `LoginPopupSequence` invokes `runForLogin(user)` as step 2 of its serial
 * welcome-popup chain, immediately after the legal step. The order matters: the
 * user should be able to read the Privacy Policy that explains why a date of
 * birth is being collected before being asked for one.
 *
 * This class is the PROMPT, not the enforcement. The server's EnsureAgeConsent
 * plugin 403s every protected endpoint until the same state is satisfied, so a
 * client that skipped this dialog gets an unusable session rather than an
 * ungated one. Everything here is written on that assumption: the server
 * decides, this only asks.
 *
 *   1. GET /Age/State — what does this account still owe?
 *   2. UNDECLARED → non-dismissable date-of-birth modal
 *      → POST /Age/DeclareDateOfBirth. The server derives the age; the reply
 *        says whether a guardian step follows.
 *   3. MINOR_AWAITING_GUARDIAN_CONSENT → non-dismissable guardian-details modal
 *      → POST /Age/GuardianConsent.
 *   4. Either modal can be declined, which logs out — mirroring the terms flow,
 *      because an account that will not answer cannot lawfully be processed.
 *
 * Both modals are deliberately non-dismissable and offer no "later". A
 * dismissable prompt in front of a hard server gate produces an app that looks
 * usable and 403s on every action, which reads as breakage rather than as a
 * requirement.
 */
class AgeVerificationManager
{
    static #STATE_ENDPOINT = "/Age/State";
    static #DECLARE_ENDPOINT = "/Age/DeclareDateOfBirth";
    static #GUARDIAN_CONSENT_ENDPOINT = "/Age/GuardianConsent";
    static #LOGOUT_ENDPOINT = "/Logout";

    // Resolves once the age flow has SETTLED — nothing owed, everything
    // supplied, or the flow failed open. SyncOrchestrator awaits this for the
    // same reason it awaits the legal gate: while the requirement is pending
    // the server 403s every sync endpoint, and the non-dismissible sync modal
    // would otherwise stack on top of this one and trap the user behind it.
    static #ageSettledResolve = null;
    static #ageSettledPromise = new Promise(resolve => { AgeVerificationManager.#ageSettledResolve = resolve; });

    /**
     * Promise that resolves when the post-login age flow has settled. Resolves
     * instantly for returning users who already declared. Consumed by
     * SyncOrchestrator.
     */
    static whenAgeSettled()
    {
        return AgeVerificationManager.#ageSettledPromise;
    }

    /**
     * Public entry point invoked by LoginPopupSequence. Resolves once the
     * account owes nothing further, or the decline path's logout has been
     * kicked off.
     */
    static async runForLogin(user)
    {
        try
        {
            await AgeVerificationManager.#runAgeVerificationFlow(user);
        }
        finally
        {
            if (AgeVerificationManager.#ageSettledResolve)
            {
                AgeVerificationManager.#ageSettledResolve();
                AgeVerificationManager.#ageSettledResolve = null;
            }
        }
    }

    static async #runAgeVerificationFlow(user)
    {
        if (!user || UserIdentityManager.isAnonymous())
        {
            return;
        }

        let consentState = await AgeVerificationManager.#fetchState();

        // Fail open on an unreachable state endpoint, matching the legal flow.
        // The server gate is still in force, so failing open here costs a
        // confusing 403 rather than unguarded access — whereas failing closed
        // would show a date-of-birth modal to a user who already answered.
        if (consentState === null)
        {
            return;
        }

        if (consentState.state === ageConsentStates.UNDECLARED)
        {
            const declarationResult = await AgeVerificationManager.#showDateOfBirthDialog(user);

            if (declarationResult === null)
            {
                return;
            }

            consentState = { state: declarationResult.state };
        }

        if (consentState.state === ageConsentStates.MINOR_AWAITING_GUARDIAN_CONSENT)
        {
            await AgeVerificationManager.#showGuardianConsentDialog(user);
        }
    }

    static async #fetchState()
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#STATE_ENDPOINT, { method: "GET" });

            if (!response.ok)
            {
                return null;
            }

            return await response.json();
        }
        catch (stateError)
        {
            console.error("[AgeVerificationManager] Failed to fetch /Age/State:", stateError);
            return null;
        }
    }

    static #showDateOfBirthDialog(user)
    {
        return new Promise((resolve) =>
        {
            const dialog = document.createElement("dialog-box");
            dialog.classList.add("age-verification-dialog");
            document.body.appendChild(dialog);

            dialog.innerHTML =
            `
                <div class="title-section">Confirm your date of birth</div>
                <div class="message-section age-verification-content">
                    <p>
                        We ask this once. Indian data-protection law treats accounts belonging to
                        under-18s differently, and we need to know which rules apply to yours
                        before we can process your data.
                    </p>
                    <label class="age-verification-field">
                        <span>Date of birth</span>
                        <input type="date" class="date-of-birth-input" max="${AgeVerificationManager.#buildLatestPlausibleDate()}">
                    </label>
                    <p class="age-verification-note">
                        You cannot change this later without contacting support, so please check it.
                    </p>
                </div>
                <div class="age-verification-error" hidden></div>
                <div class="button-section age-verification-buttons">
                    <button class="decline-button cancel-button">Log out</button>
                    <button class="continue-button ok-button">Continue</button>
                </div>
            `;

            const dateOfBirthInput = dialog.querySelector(".date-of-birth-input");
            const declineButton = dialog.querySelector(".decline-button");
            const continueButton = dialog.querySelector(".continue-button");
            const errorElement = dialog.querySelector(".age-verification-error");

            const escapeKeyHandler = (keyDownEvent) =>
            {
                if (keyDownEvent.key === "Escape")
                {
                    // Non-dismissable: the server will refuse every request
                    // until this is answered, so letting Escape close it would
                    // just produce a silently broken session.
                    keyDownEvent.preventDefault();
                }
            };
            window.addEventListener("keydown", escapeKeyHandler);

            const cleanupObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    window.removeEventListener("keydown", escapeKeyHandler);
                    cleanupObserver.disconnect();
                }
            });
            cleanupObserver.observe(document.body, { childList: true });

            declineButton.addEventListener("click", async () =>
            {
                continueButton.disabled = true;
                declineButton.disabled = true;
                await AgeVerificationManager.#logoutAndReload();
            });

            continueButton.addEventListener("click", async () =>
            {
                const submittedDateOfBirth = (dateOfBirthInput.value || "").trim();

                if (submittedDateOfBirth.length === 0)
                {
                    AgeVerificationManager.#showError(errorElement, "Please enter your date of birth.");
                    return;
                }

                continueButton.disabled = true;
                declineButton.disabled = true;
                AgeVerificationManager.#hideError(errorElement);

                const declarationResult = await AgeVerificationManager.#submitDateOfBirth(user, submittedDateOfBirth);

                if (declarationResult === null)
                {
                    continueButton.disabled = false;
                    declineButton.disabled = false;
                    AgeVerificationManager.#showError(errorElement, "That date does not look right. Please check it and try again.");
                    return;
                }

                dialog.remove();
                resolve(declarationResult);
            });
        });
    }

    static #showGuardianConsentDialog(user)
    {
        return new Promise((resolve) =>
        {
            const dialog = document.createElement("dialog-box");
            dialog.classList.add("age-verification-dialog");
            document.body.appendChild(dialog);

            dialog.innerHTML =
            `
                <div class="title-section">A parent or guardian needs to agree</div>
                <div class="message-section age-verification-content">
                    <p>
                        Because you are under ${AgeVerificationConstants.AGE_OF_MAJORITY_YEARS}, we need a parent's or
                        lawful guardian's consent before we can process your data. Please ask them
                        to fill this in — we may contact them to confirm.
                    </p>
                    <label class="age-verification-field">
                        <span>Parent / guardian full name</span>
                        <input type="text" class="guardian-name-input" maxlength="${AgeVerificationConstants.GUARDIAN_NAME_MAXIMUM_LENGTH}">
                    </label>
                    <label class="age-verification-field">
                        <span>Relationship to you</span>
                        <input type="text" class="guardian-relationship-input" maxlength="${AgeVerificationConstants.GUARDIAN_RELATIONSHIP_MAXIMUM_LENGTH}">
                    </label>
                    <label class="age-verification-field">
                        <span>Their email address</span>
                        <input type="email" class="guardian-email-input" maxlength="${AgeVerificationConstants.GUARDIAN_EMAIL_MAXIMUM_LENGTH}">
                    </label>
                    <label class="age-verification-field">
                        <span>Their contact number</span>
                        <input type="tel" class="guardian-contact-input" maxlength="${AgeVerificationConstants.GUARDIAN_CONTACT_NUMBER_MAXIMUM_LENGTH}">
                    </label>
                    <p class="age-verification-note">
                        By continuing, the parent or guardian named above confirms they consent to
                        this account being used and to the processing described in our Privacy Policy.
                    </p>
                </div>
                <div class="age-verification-error" hidden></div>
                <div class="button-section age-verification-buttons">
                    <button class="decline-button cancel-button">Log out</button>
                    <button class="continue-button ok-button">I consent</button>
                </div>
            `;

            const declineButton = dialog.querySelector(".decline-button");
            const continueButton = dialog.querySelector(".continue-button");
            const errorElement = dialog.querySelector(".age-verification-error");

            const escapeKeyHandler = (keyDownEvent) =>
            {
                if (keyDownEvent.key === "Escape")
                {
                    keyDownEvent.preventDefault();
                }
            };
            window.addEventListener("keydown", escapeKeyHandler);

            const cleanupObserver = new MutationObserver(() =>
            {
                if (!document.body.contains(dialog))
                {
                    window.removeEventListener("keydown", escapeKeyHandler);
                    cleanupObserver.disconnect();
                }
            });
            cleanupObserver.observe(document.body, { childList: true });

            declineButton.addEventListener("click", async () =>
            {
                continueButton.disabled = true;
                declineButton.disabled = true;
                await AgeVerificationManager.#logoutAndReload();
            });

            continueButton.addEventListener("click", async () =>
            {
                const guardianDetails =
                {
                    guardianName: (dialog.querySelector(".guardian-name-input").value || "").trim(),
                    guardianRelationship: (dialog.querySelector(".guardian-relationship-input").value || "").trim(),
                    guardianEmail: (dialog.querySelector(".guardian-email-input").value || "").trim(),
                    guardianContactNumber: (dialog.querySelector(".guardian-contact-input").value || "").trim()
                };

                const missingField = Object.values(guardianDetails).some(fieldValue => fieldValue.length === 0);

                if (missingField)
                {
                    AgeVerificationManager.#showError(errorElement, "Please fill in every field.");
                    return;
                }

                continueButton.disabled = true;
                declineButton.disabled = true;
                AgeVerificationManager.#hideError(errorElement);

                const bRecorded = await AgeVerificationManager.#submitGuardianConsent(user, guardianDetails);

                if (!bRecorded)
                {
                    continueButton.disabled = false;
                    declineButton.disabled = false;
                    AgeVerificationManager.#showError(errorElement, "We could not record that. Please check the email address and try again.");
                    return;
                }

                dialog.remove();
                resolve(true);
            });
        });
    }

    static async #submitDateOfBirth(user, dateOfBirthIsoDate)
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#DECLARE_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ dateOfBirth: dateOfBirthIsoDate })
            });

            if (!response.ok)
            {
                console.error(`[AgeVerificationManager] Date-of-birth declaration failed: status ${response.status}`);
                return null;
            }

            const responseJson = await response.json();

            if (responseJson?.additionalData)
            {
                user.setAdditionalData(responseJson.additionalData);
            }

            return { state: responseJson?.state };
        }
        catch (declarationError)
        {
            console.error("[AgeVerificationManager] Date-of-birth declaration failed:", declarationError);
            return null;
        }
    }

    static async #submitGuardianConsent(user, guardianDetails)
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#GUARDIAN_CONSENT_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(guardianDetails)
            });

            if (!response.ok)
            {
                console.error(`[AgeVerificationManager] Guardian consent failed: status ${response.status}`);
                return false;
            }

            const responseJson = await response.json();

            if (responseJson?.additionalData)
            {
                user.setAdditionalData(responseJson.additionalData);
            }

            return true;
        }
        catch (consentError)
        {
            console.error("[AgeVerificationManager] Guardian consent failed:", consentError);
            return false;
        }
    }

    /**
     * The most recent date that could belong to somebody old enough to be
     * plausible, used as the picker's upper bound. Stops the obvious typo of a
     * future or same-week date before it reaches the server.
     */
    static #buildLatestPlausibleDate()
    {
        const latestPlausibleDate = new Date();
        latestPlausibleDate.setFullYear(latestPlausibleDate.getFullYear() - AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS);
        return latestPlausibleDate.toISOString().slice(0, 10);
    }

    static #showError(errorElement, message)
    {
        errorElement.textContent = message;
        errorElement.hidden = false;
    }

    static #hideError(errorElement)
    {
        errorElement.textContent = "";
        errorElement.hidden = true;
    }

    static async #logoutAndReload()
    {
        try
        {
            await fetch(AgeVerificationManager.#LOGOUT_ENDPOINT, { method: "POST" });
        }
        catch (logoutError)
        {
            console.error("[AgeVerificationManager] Logout failed:", logoutError);
        }

        window.location.reload();
    }
}

export default AgeVerificationManager;
