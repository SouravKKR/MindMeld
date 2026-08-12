import UserIdentityManager from "./UserIdentityManager.js";
import { ageConsentStates } from "../Enumerations/AgeConsentStates.js";
import AgeVerificationConstants from "../Constants/AgeVerificationConstants.js";
import ErrorCodes from "../Constants/ErrorCodes.js";

/**
 * AgeVerificationManager
 *
 * Owns the post-login age flow: collect an age, and where that age makes the
 * account holder a Child (under 18, the definition the Privacy Policy uses),
 * obtain a parent's or guardian's consent before the account may be used.
 *
 * `LoginPopupSequence` invokes `runForLogin(user)` as step 2 of its serial
 * welcome-popup chain, immediately after the legal step. The order matters: the
 * user should be able to read the Privacy Policy that explains why an age is
 * being collected before being asked for one.
 *
 * This class is the PROMPT, not the enforcement. The server's EnsureAgeConsent
 * plugin 403s every protected endpoint until the same state is satisfied, so a
 * client that skipped these dialogs gets an unusable session rather than an
 * ungated one. Everything here is written on that assumption: the server
 * decides, this only asks.
 *
 *   1. GET /Age/State — what does this account still owe?
 *   2. UNDECLARED → non-dismissable age modal
 *      → POST /Age/DeclareAge. The reply says whether a guardian step follows.
 *   3. MINOR_AWAITING_GUARDIAN_CONSENT → non-dismissable guardian modal, in two
 *      phases within the one dialog:
 *        a. details → POST /Age/GuardianConsent/RequestCode, which emails the
 *           guardian the consent notice and a six-digit code;
 *        b. code    → POST /Age/GuardianConsent/Verify, which records consent.
 *      Only (b) unblocks the account. Filling in (a) repeatedly changes nothing,
 *      which is the entire point of the split.
 *   4. Any modal can be declined, which logs out — mirroring the terms flow,
 *      because an account that will not answer cannot lawfully be processed.
 *
 * The dialogs are deliberately non-dismissable and offer no "later". A
 * dismissable prompt in front of a hard server gate produces an app that looks
 * usable and 403s on every action, which reads as breakage rather than as a
 * requirement.
 */
class AgeVerificationManager
{
    static #STATE_ENDPOINT = "/Age/State";
    static #DECLARE_AGE_ENDPOINT = "/Age/DeclareAge";
    static #GUARDIAN_REQUEST_CODE_ENDPOINT = "/Age/GuardianConsent/RequestCode";
    static #GUARDIAN_VERIFY_ENDPOINT = "/Age/GuardianConsent/Verify";
    static #LOGOUT_ENDPOINT = "/Logout";

    static #CONSENT_CODE_DIGITS = 6;
    static #FALLBACK_RESEND_COOLDOWN_SECONDS = 60;

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
        // would show an age modal to a user who already answered.
        if (consentState === null)
        {
            return;
        }

        if (consentState.state === ageConsentStates.UNDECLARED)
        {
            const declarationResult = await AgeVerificationManager.#showAgeDialog(user);

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

    static #showAgeDialog(user)
    {
        return new Promise((resolve) =>
        {
            const dialog = AgeVerificationManager.#createDialog();

            dialog.innerHTML =
            `
                <div class="title-section">How old are you?</div>
                <div class="message-section age-verification-content">
                    <p>
                        We ask this once. Indian data-protection law treats accounts belonging to
                        under-18s differently, and we need to know which rules apply to yours
                        before we can process your data.
                    </p>
                    <label class="age-verification-field">
                        <span>Your age in years</span>
                        <input type="number" class="age-input" inputmode="numeric"
                               min="${AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS}"
                               max="${AgeVerificationConstants.MAXIMUM_PLAUSIBLE_AGE_YEARS}">
                    </label>
                    <p class="age-verification-note">
                        We ask for your age rather than your date of birth because it is the least
                        we need in order to know which rules apply. You cannot change this later
                        without contacting support, so please check it.
                    </p>
                </div>
                <div class="age-verification-error" hidden></div>
                <div class="button-section age-verification-buttons">
                    <button class="decline-button cancel-button">Log out</button>
                    <button class="continue-button ok-button">Continue</button>
                </div>
            `;

            const ageInput = dialog.querySelector(".age-input");
            const declineButton = dialog.querySelector(".decline-button");
            const continueButton = dialog.querySelector(".continue-button");
            const errorElement = dialog.querySelector(".age-verification-error");

            declineButton.addEventListener("click", async () =>
            {
                continueButton.disabled = true;
                declineButton.disabled = true;
                await AgeVerificationManager.#logoutAndReload();
            });

            continueButton.addEventListener("click", async () =>
            {
                const submittedAge = (ageInput.value || "").trim();

                if (!/^\d{1,3}$/.test(submittedAge))
                {
                    AgeVerificationManager.#showError(errorElement, "Please enter your age in whole years.");
                    return;
                }

                const ageYears = Number(submittedAge);

                if (ageYears < AgeVerificationConstants.MINIMUM_PLAUSIBLE_AGE_YEARS
                    || ageYears > AgeVerificationConstants.MAXIMUM_PLAUSIBLE_AGE_YEARS)
                {
                    AgeVerificationManager.#showError(errorElement, "That does not look like a real age. Please check it.");
                    return;
                }

                continueButton.disabled = true;
                declineButton.disabled = true;
                AgeVerificationManager.#hideError(errorElement);

                const declarationResult = await AgeVerificationManager.#submitAge(user, ageYears);

                if (declarationResult === null)
                {
                    continueButton.disabled = false;
                    declineButton.disabled = false;
                    AgeVerificationManager.#showError(errorElement, "We could not record that. Please check it and try again.");
                    return;
                }

                dialog.remove();
                resolve(declarationResult);
            });
        });
    }

    /**
     * The two-phase guardian dialog. Both phases live in one dialog element so
     * the child never loses the details they typed when a code fails, and so
     * "use a different address" is a step back rather than a restart.
     */
    static #showGuardianConsentDialog(user)
    {
        return new Promise((resolve) =>
        {
            const dialog = AgeVerificationManager.#createDialog();

            dialog.innerHTML =
            `
                <div class="title-section">A parent or guardian needs to agree</div>
                <div class="message-section age-verification-content">
                    <div class="guardian-details-phase">
                        <p>
                            Because you are under ${AgeVerificationConstants.AGE_OF_MAJORITY_YEARS}, we need a parent's or
                            lawful guardian's consent before we can process your data. Tell us how to reach
                            them and we will email them what we do and ask them to agree.
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
                            This must be their own email address, not yours. We will send them a code —
                            giving it to you is how they record their consent.
                        </p>
                    </div>
                    <div class="guardian-code-phase" hidden>
                        <p>
                            We have emailed <strong class="guardian-email-echo"></strong> explaining what
                            CogniumLearn does with your data, along with a
                            ${AgeVerificationManager.#CONSENT_CODE_DIGITS}-digit code.
                        </p>
                        <p>
                            Ask them to read it. If they agree, they can give you the code to enter below.
                        </p>
                        <label class="age-verification-field">
                            <span>Code from your parent or guardian</span>
                            <input type="text" class="guardian-code-input" inputmode="numeric" autocomplete="one-time-code"
                                   maxlength="${AgeVerificationManager.#CONSENT_CODE_DIGITS}">
                        </label>
                        <p class="age-verification-note">
                            The code expires after a few minutes.
                            <button type="button" class="guardian-resend-button link-button"></button>
                            <button type="button" class="guardian-change-email-button link-button">Use a different address</button>
                        </p>
                    </div>
                </div>
                <div class="age-verification-error" hidden></div>
                <div class="button-section age-verification-buttons">
                    <button class="decline-button cancel-button">Log out</button>
                    <button class="continue-button ok-button">Send them the request</button>
                </div>
            `;

            const detailsPhase = dialog.querySelector(".guardian-details-phase");
            const codePhase = dialog.querySelector(".guardian-code-phase");
            const emailEcho = dialog.querySelector(".guardian-email-echo");
            const codeInput = dialog.querySelector(".guardian-code-input");
            const resendButton = dialog.querySelector(".guardian-resend-button");
            const changeEmailButton = dialog.querySelector(".guardian-change-email-button");
            const declineButton = dialog.querySelector(".decline-button");
            const continueButton = dialog.querySelector(".continue-button");
            const errorElement = dialog.querySelector(".age-verification-error");

            let resendCountdownTimer = null;

            const stopResendCountdown = () =>
            {
                if (resendCountdownTimer !== null)
                {
                    clearInterval(resendCountdownTimer);
                    resendCountdownTimer = null;
                }
            };

            const startResendCountdown = (cooldownSeconds) =>
            {
                stopResendCountdown();

                let remainingSeconds = Math.max(0, Math.ceil(Number(cooldownSeconds) || AgeVerificationManager.#FALLBACK_RESEND_COOLDOWN_SECONDS));

                const render = () =>
                {
                    if (remainingSeconds <= 0)
                    {
                        stopResendCountdown();
                        resendButton.disabled = false;
                        resendButton.textContent = "Send it again";
                        return;
                    }

                    resendButton.disabled = true;
                    resendButton.textContent = `Send it again in ${remainingSeconds}s`;
                    remainingSeconds--;
                };

                render();
                resendCountdownTimer = setInterval(render, 1000);
            };

            const readGuardianDetails = () => (
            {
                guardianName: (dialog.querySelector(".guardian-name-input").value || "").trim(),
                guardianRelationship: (dialog.querySelector(".guardian-relationship-input").value || "").trim(),
                guardianEmail: (dialog.querySelector(".guardian-email-input").value || "").trim(),
                guardianContactNumber: (dialog.querySelector(".guardian-contact-input").value || "").trim()
            });

            const showDetailsPhase = () =>
            {
                stopResendCountdown();
                detailsPhase.hidden = false;
                codePhase.hidden = true;
                continueButton.textContent = "Send them the request";
                AgeVerificationManager.#hideError(errorElement);
            };

            const showCodePhase = (guardianEmail, cooldownSeconds) =>
            {
                detailsPhase.hidden = true;
                codePhase.hidden = false;
                emailEcho.textContent = guardianEmail;
                continueButton.textContent = "Confirm consent";
                codeInput.value = "";
                AgeVerificationManager.#hideError(errorElement);
                startResendCountdown(cooldownSeconds);
                codeInput.focus();
            };

            const requestCode = async () =>
            {
                const guardianDetails = readGuardianDetails();

                if (Object.values(guardianDetails).some(fieldValue => fieldValue.length === 0))
                {
                    AgeVerificationManager.#showError(errorElement, "Please fill in every field.");
                    return;
                }

                continueButton.disabled = true;
                declineButton.disabled = true;
                resendButton.disabled = true;
                AgeVerificationManager.#hideError(errorElement);

                const requestResult = await AgeVerificationManager.#requestGuardianConsentCode(guardianDetails);

                continueButton.disabled = false;
                declineButton.disabled = false;

                if (!requestResult.ok)
                {
                    // A rate-limited resend is not a failure of the details — the
                    // code already sent is still valid, so the code phase stays up
                    // and only the countdown is restarted.
                    if (requestResult.error === ErrorCodes.RATE_LIMITED && !codePhase.hidden)
                    {
                        startResendCountdown(requestResult.retryAfterSeconds);
                        AgeVerificationManager.#showError(errorElement, "We already sent a code. Please wait before asking for another.");
                        return;
                    }

                    showDetailsPhase();
                    AgeVerificationManager.#showError(errorElement, AgeVerificationManager.#describeGuardianError(requestResult.error));
                    return;
                }

                showCodePhase(requestResult.guardianEmail || guardianDetails.guardianEmail, requestResult.retryAfterSeconds);
            };

            const confirmCode = async () =>
            {
                const submittedCode = (codeInput.value || "").trim();

                if (!new RegExp(`^\\d{${AgeVerificationManager.#CONSENT_CODE_DIGITS}}$`).test(submittedCode))
                {
                    AgeVerificationManager.#showError(errorElement, `Please enter the ${AgeVerificationManager.#CONSENT_CODE_DIGITS}-digit code from the email.`);
                    return;
                }

                continueButton.disabled = true;
                declineButton.disabled = true;
                AgeVerificationManager.#hideError(errorElement);

                const verifyResult = await AgeVerificationManager.#verifyGuardianConsentCode(user, submittedCode);

                continueButton.disabled = false;
                declineButton.disabled = false;

                if (!verifyResult.ok)
                {
                    // A burned or expired code cannot be retried, so the flow goes
                    // back to the details phase where a fresh one can be requested
                    // — leaving the code box up would invite five more failures
                    // against a code that no longer exists.
                    if (verifyResult.error === ErrorCodes.TOO_MANY_ATTEMPTS
                        || verifyResult.error === ErrorCodes.EXPIRED
                        || verifyResult.error === ErrorCodes.GUARDIAN_CONSENT_CODE_NOT_REQUESTED)
                    {
                        showDetailsPhase();
                    }

                    AgeVerificationManager.#showError(errorElement, AgeVerificationManager.#describeGuardianError(verifyResult.error, verifyResult.attemptsRemaining));
                    return;
                }

                stopResendCountdown();
                dialog.remove();
                resolve(true);
            };

            resendButton.addEventListener("click", requestCode);

            changeEmailButton.addEventListener("click", showDetailsPhase);

            declineButton.addEventListener("click", async () =>
            {
                stopResendCountdown();
                continueButton.disabled = true;
                declineButton.disabled = true;
                await AgeVerificationManager.#logoutAndReload();
            });

            continueButton.addEventListener("click", async () =>
            {
                if (codePhase.hidden)
                {
                    await requestCode();
                    return;
                }

                await confirmCode();
            });
        });
    }

    /**
     * Creates the blocking dialog shell shared by both steps, including the
     * Escape trap and the listener cleanup that follows the element out of the
     * DOM.
     */
    static #createDialog()
    {
        const dialog = document.createElement("dialog-box");
        dialog.classList.add("age-verification-dialog");
        document.body.appendChild(dialog);

        const escapeKeyHandler = (keyDownEvent) =>
        {
            if (keyDownEvent.key === "Escape")
            {
                // Non-dismissable: the server will refuse every request until
                // this is answered, so letting Escape close it would just
                // produce a silently broken session.
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

        return dialog;
    }

    /**
     * Turns a server error code into something a teenager reading it can act on.
     * Deliberately does not echo the raw code — every one of these has a
     * next action, and naming it is more use than naming the failure.
     */
    static #describeGuardianError(errorCode, attemptsRemaining)
    {
        if (errorCode === ErrorCodes.GUARDIAN_EMAIL_SAME_AS_ACCOUNT)
        {
            return "That is your own email address. Please enter your parent's or guardian's own address.";
        }

        if (errorCode === ErrorCodes.GUARDIAN_DETAILS_INCOMPLETE || errorCode === ErrorCodes.INVALID_EMAIL)
        {
            return "Please check the details — that email address does not look right.";
        }

        if (errorCode === ErrorCodes.RATE_LIMITED)
        {
            return "We have sent a few of these already. Please wait a moment before trying again.";
        }

        if (errorCode === ErrorCodes.INVALID_CODE)
        {
            const remaining = Number(attemptsRemaining);
            if (Number.isInteger(remaining) && remaining > 0)
            {
                return `That code is not right. ${remaining} ${remaining === 1 ? "try" : "tries"} left before you need a new one.`;
            }
            return "That code is not right. Please check it and try again.";
        }

        if (errorCode === ErrorCodes.EXPIRED)
        {
            return "That code has expired. Ask us to send a fresh one.";
        }

        if (errorCode === ErrorCodes.TOO_MANY_ATTEMPTS)
        {
            return "Too many wrong tries. We will need to send a new code.";
        }

        if (errorCode === ErrorCodes.GUARDIAN_CONSENT_CODE_NOT_REQUESTED)
        {
            return "We do not have a code waiting. Please send the request again.";
        }

        return "We could not do that just now. Please try again.";
    }

    static async #submitAge(user, ageYears)
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#DECLARE_AGE_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ageYears: ageYears })
            });

            if (!response.ok)
            {
                console.error(`[AgeVerificationManager] Age declaration failed: status ${response.status}`);
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
            console.error("[AgeVerificationManager] Age declaration failed:", declarationError);
            return null;
        }
    }

    static async #requestGuardianConsentCode(guardianDetails)
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#GUARDIAN_REQUEST_CODE_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(guardianDetails)
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok)
            {
                return { ok: false, error: responseJson?.error, retryAfterSeconds: responseJson?.retryAfterSeconds };
            }

            return {
                ok: true,
                guardianEmail: responseJson?.guardianEmail,
                retryAfterSeconds: responseJson?.retryAfterSeconds
            };
        }
        catch (requestError)
        {
            console.error("[AgeVerificationManager] Guardian consent code request failed:", requestError);
            return { ok: false, error: null };
        }
    }

    static async #verifyGuardianConsentCode(user, submittedCode)
    {
        try
        {
            const response = await fetch(AgeVerificationManager.#GUARDIAN_VERIFY_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: submittedCode })
            });

            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok)
            {
                return { ok: false, error: responseJson?.error, attemptsRemaining: responseJson?.attemptsRemaining };
            }

            if (responseJson?.additionalData)
            {
                user.setAdditionalData(responseJson.additionalData);
            }

            return { ok: true };
        }
        catch (verifyError)
        {
            console.error("[AgeVerificationManager] Guardian consent verification failed:", verifyError);
            return { ok: false, error: null };
        }
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
