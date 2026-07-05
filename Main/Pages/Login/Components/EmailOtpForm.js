const STATE_EMAIL_ENTRY = "EMAIL_ENTRY";
const STATE_OTP_ENTRY = "OTP_ENTRY";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_COOLDOWN_SECONDS = 60;
const OTP_BOX_COUNT = 6;

class EmailOtpForm extends HTMLElement
{
    #currentState = STATE_EMAIL_ENTRY;
    #email = "";
    #isNewUser = false;
    #isBusy = false;
    #statusMessage = "";
    #statusIsError = false;
    #resendCooldownIntervalId = null;
    #resendSecondsRemaining = 0;

    connectedCallback()
    {
        this.#render();
    }

    disconnectedCallback()
    {
        if (this.#resendCooldownIntervalId !== null)
        {
            clearInterval(this.#resendCooldownIntervalId);
            this.#resendCooldownIntervalId = null;
        }
    }

    #render()
    {
        if (this.#currentState === STATE_EMAIL_ENTRY)
        {
            this.#renderEmailEntry();
        }
        else
        {
            this.#renderOtpEntry();
        }
    }

    #renderEmailEntry()
    {
        const statusHtml = this.#renderStatusHtml();
        this.innerHTML =
        `
            <form class="email-otp-form" novalidate>
                <input class="email-otp-email-input"
                       type="email"
                       autocomplete="email"
                       inputmode="email"
                       placeholder="you@example.com"
                       value="${this.#escapeAttribute(this.#email)}"
                       required>
                <button class="login-provider-button email-otp-primary-button" type="submit">
                    <span class="login-provider-label">Continue with email</span>
                </button>
                ${statusHtml}
            </form>
        `;

        const formElement = this.querySelector(".email-otp-form");
        const emailInput = this.querySelector(".email-otp-email-input");

        formElement.addEventListener("submit", async (submitEvent) =>
        {
            submitEvent.preventDefault();
            await this.#submitEmail(emailInput.value);
        });

        emailInput.focus();
    }

    #renderOtpEntry()
    {
        const otpBoxesHtml = Array.from({ length: OTP_BOX_COUNT }).map((_, boxIndex) =>
            `<input class="email-otp-digit-input"
                    data-digit-index="${boxIndex}"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="1"
                    aria-label="Digit ${boxIndex + 1}">`
        ).join("");

        const nameFieldHtml = this.#isNewUser
            ? `
                <label class="email-otp-name-label">
                    <span class="email-otp-name-label-text">Your name</span>
                    <input class="email-otp-name-input"
                           type="text"
                           autocomplete="name"
                           placeholder="What should we call you?"
                           maxlength="256"
                           required>
                </label>
            `
            : "";

        const statusHtml = this.#renderStatusHtml();

        const resendLabel = this.#resendSecondsRemaining > 0
            ? `Resend code in ${this.#resendSecondsRemaining}s`
            : "Resend code";

        this.innerHTML =
        `
            <form class="email-otp-form email-otp-form-verify" novalidate>
                <div class="email-otp-instruction">
                    We sent a 6-digit code to
                    <span class="email-otp-email-display">${this.#escapeText(this.#email)}</span>
                </div>
                <div class="email-otp-digit-row">
                    ${otpBoxesHtml}
                </div>
                ${nameFieldHtml}
                <button class="login-provider-button email-otp-primary-button" type="submit">
                    <span class="login-provider-label">Verify and sign in</span>
                </button>
                ${statusHtml}
                <div class="email-otp-secondary-actions">
                    <button class="email-otp-link-button" type="button" data-action="change-email">
                        Use a different email
                    </button>
                    <button class="email-otp-link-button" type="button" data-action="resend"
                            ${this.#resendSecondsRemaining > 0 ? "disabled" : ""}>
                        ${resendLabel}
                    </button>
                </div>
            </form>
        `;

        this.#wireOtpDigitInputs();

        const formElement = this.querySelector(".email-otp-form-verify");
        formElement.addEventListener("submit", async (submitEvent) =>
        {
            submitEvent.preventDefault();
            await this.#submitOtp();
        });

        const changeEmailButton = this.querySelector('[data-action="change-email"]');
        changeEmailButton.addEventListener("click", () =>
        {
            if (this.#isBusy)
            {
                return;
            }
            this.#stopResendCountdown();
            this.#currentState = STATE_EMAIL_ENTRY;
            this.#statusMessage = "";
            this.#statusIsError = false;
            this.#render();
        });

        const resendButton = this.querySelector('[data-action="resend"]');
        resendButton.addEventListener("click", async () =>
        {
            if (this.#isBusy || this.#resendSecondsRemaining > 0)
            {
                return;
            }
            await this.#submitEmail(this.#email);
        });

        const firstDigitInput = this.querySelector('.email-otp-digit-input[data-digit-index="0"]');
        if (firstDigitInput)
        {
            firstDigitInput.focus();
        }
    }

    #wireOtpDigitInputs()
    {
        const digitInputs = Array.from(this.querySelectorAll(".email-otp-digit-input"));

        for (const digitInput of digitInputs)
        {
            digitInput.addEventListener("input", (inputEvent) =>
            {
                const rawValue = inputEvent.target.value;
                const sanitisedValue = rawValue.replace(/\D/g, "").slice(0, 1);
                inputEvent.target.value = sanitisedValue;

                if (sanitisedValue.length === 1)
                {
                    const currentIndex = Number(inputEvent.target.getAttribute("data-digit-index"));
                    const nextInput = digitInputs[currentIndex + 1];
                    if (nextInput)
                    {
                        nextInput.focus();
                        nextInput.select();
                    }
                    else
                    {
                        const collectedCode = digitInputs.map(box => box.value).join("");
                        if (collectedCode.length === OTP_BOX_COUNT)
                        {
                            this.#submitOtp();
                        }
                    }
                }
            });

            digitInput.addEventListener("keydown", (keyboardEvent) =>
            {
                const currentIndex = Number(keyboardEvent.target.getAttribute("data-digit-index"));

                if (keyboardEvent.key === "Backspace" && keyboardEvent.target.value.length === 0)
                {
                    const previousInput = digitInputs[currentIndex - 1];
                    if (previousInput)
                    {
                        previousInput.focus();
                        previousInput.value = "";
                    }
                }
                else if (keyboardEvent.key === "ArrowLeft")
                {
                    const previousInput = digitInputs[currentIndex - 1];
                    if (previousInput)
                    {
                        keyboardEvent.preventDefault();
                        previousInput.focus();
                        previousInput.select();
                    }
                }
                else if (keyboardEvent.key === "ArrowRight")
                {
                    const nextInput = digitInputs[currentIndex + 1];
                    if (nextInput)
                    {
                        keyboardEvent.preventDefault();
                        nextInput.focus();
                        nextInput.select();
                    }
                }
            });

            digitInput.addEventListener("paste", (pasteEvent) =>
            {
                const clipboardText = (pasteEvent.clipboardData || window.clipboardData)?.getData("text") || "";
                const digitsOnly = clipboardText.replace(/\D/g, "").slice(0, OTP_BOX_COUNT);
                if (digitsOnly.length === 0)
                {
                    return;
                }

                pasteEvent.preventDefault();
                for (let boxIndex = 0; boxIndex < digitInputs.length; boxIndex++)
                {
                    digitInputs[boxIndex].value = digitsOnly[boxIndex] || "";
                }

                const lastFilledIndex = Math.min(digitsOnly.length, digitInputs.length) - 1;
                const focusTarget = digitInputs[Math.min(lastFilledIndex + 1, digitInputs.length - 1)];
                if (focusTarget)
                {
                    focusTarget.focus();
                }

                if (digitsOnly.length === OTP_BOX_COUNT)
                {
                    this.#submitOtp();
                }
            });
        }
    }

    async #submitEmail(rawEmail)
    {
        if (this.#isBusy)
        {
            return;
        }

        const normalisedEmail = (rawEmail || "").trim().toLowerCase();
        if (!EMAIL_REGEX.test(normalisedEmail))
        {
            this.#statusMessage = "Please enter a valid email address.";
            this.#statusIsError = true;
            this.#updateStatusElement();
            return;
        }

        this.#email = normalisedEmail;
        this.#setBusy(true);
        this.#statusMessage = "Sending code…";
        this.#statusIsError = false;
        this.#updateStatusElement();

        try
        {
            const networkResponse = await fetch("/Auth/RequestOtp",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: normalisedEmail })
            });

            const responseJson = await networkResponse.json().catch(() => null);

            if (!networkResponse.ok || !responseJson?.success)
            {
                this.#statusMessage = this.#humaniseRequestError(responseJson?.error, responseJson?.retryAfterSeconds);
                this.#statusIsError = true;
                this.#setBusy(false);
                this.#updateStatusElement();
                return;
            }

            this.#isNewUser = Boolean(responseJson.isNewUser);
            this.#currentState = STATE_OTP_ENTRY;
            this.#statusMessage = "";
            this.#statusIsError = false;
            this.#setBusy(false);
            this.#render();
            this.#startResendCountdown(responseJson.retryAfterSeconds || RESEND_COOLDOWN_SECONDS);
        }
        catch (networkError)
        {
            this.#statusMessage = "Network error. Please try again.";
            this.#statusIsError = true;
            this.#setBusy(false);
            this.#updateStatusElement();
        }
    }

    async #submitOtp()
    {
        if (this.#isBusy)
        {
            return;
        }

        const digitInputs = Array.from(this.querySelectorAll(".email-otp-digit-input"));
        const collectedCode = digitInputs.map(box => box.value).join("");
        if (!/^\d{6}$/.test(collectedCode))
        {
            this.#statusMessage = "Please enter all 6 digits.";
            this.#statusIsError = true;
            this.#updateStatusElement();
            return;
        }

        let displayName = "";
        if (this.#isNewUser)
        {
            const nameInput = this.querySelector(".email-otp-name-input");
            displayName = nameInput?.value?.trim() || "";
            if (!displayName)
            {
                this.#statusMessage = "Please enter your name to create your account.";
                this.#statusIsError = true;
                this.#updateStatusElement();
                nameInput?.focus();
                return;
            }
        }

        this.#setBusy(true);
        this.#statusMessage = "Verifying…";
        this.#statusIsError = false;
        this.#updateStatusElement();

        try
        {
            const networkResponse = await fetch("/Auth/VerifyOtp",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: this.#email, code: collectedCode, displayName: displayName })
            });

            const responseJson = await networkResponse.json().catch(() => null);

            if (!networkResponse.ok || !responseJson?.success)
            {
                this.#statusMessage = this.#humaniseVerifyError(responseJson?.error, responseJson?.attemptsRemaining);
                this.#statusIsError = true;

                if (responseJson?.error === "TOO_MANY_ATTEMPTS" || responseJson?.error === "EXPIRED")
                {
                    this.#stopResendCountdown();
                    this.#currentState = STATE_EMAIL_ENTRY;
                    this.#setBusy(false);
                    this.#render();
                    this.#updateStatusElement();
                    return;
                }

                for (const digitInput of digitInputs)
                {
                    digitInput.value = "";
                }
                digitInputs[0]?.focus();
                this.#setBusy(false);
                this.#updateStatusElement();
                return;
            }

            this.#statusMessage = "Signed in. Loading…";
            this.#statusIsError = false;
            this.#updateStatusElement();
            window.location.reload();
        }
        catch (networkError)
        {
            this.#statusMessage = "Network error. Please try again.";
            this.#statusIsError = true;
            this.#setBusy(false);
            this.#updateStatusElement();
        }
    }

    #setBusy(busy)
    {
        this.#isBusy = busy;
        const primaryButton = this.querySelector(".email-otp-primary-button");
        if (primaryButton)
        {
            primaryButton.disabled = busy;
        }
        const emailInput = this.querySelector(".email-otp-email-input");
        if (emailInput)
        {
            emailInput.disabled = busy;
        }
        for (const digitInput of this.querySelectorAll(".email-otp-digit-input"))
        {
            digitInput.disabled = busy;
        }
        const nameInput = this.querySelector(".email-otp-name-input");
        if (nameInput)
        {
            nameInput.disabled = busy;
        }
    }

    #renderStatusHtml()
    {
        if (!this.#statusMessage)
        {
            return `<div class="email-otp-status" data-status-area></div>`;
        }
        const statusClass = this.#statusIsError ? "email-otp-status email-otp-status-error" : "email-otp-status";
        return `<div class="${statusClass}" data-status-area>${this.#escapeText(this.#statusMessage)}</div>`;
    }

    #updateStatusElement()
    {
        const statusElement = this.querySelector("[data-status-area]");
        if (!statusElement)
        {
            return;
        }
        statusElement.textContent = this.#statusMessage;
        statusElement.classList.toggle("email-otp-status-error", this.#statusIsError && Boolean(this.#statusMessage));
    }

    #startResendCountdown(seconds)
    {
        this.#stopResendCountdown();
        this.#resendSecondsRemaining = Math.max(0, Math.ceil(seconds));
        this.#updateResendButton();

        this.#resendCooldownIntervalId = setInterval(() =>
        {
            this.#resendSecondsRemaining = Math.max(0, this.#resendSecondsRemaining - 1);
            this.#updateResendButton();
            if (this.#resendSecondsRemaining <= 0)
            {
                this.#stopResendCountdown();
            }
        }, 1000);
    }

    #stopResendCountdown()
    {
        if (this.#resendCooldownIntervalId !== null)
        {
            clearInterval(this.#resendCooldownIntervalId);
            this.#resendCooldownIntervalId = null;
        }
        this.#resendSecondsRemaining = 0;
        this.#updateResendButton();
    }

    #updateResendButton()
    {
        const resendButton = this.querySelector('[data-action="resend"]');
        if (!resendButton)
        {
            return;
        }
        if (this.#resendSecondsRemaining > 0)
        {
            resendButton.disabled = true;
            resendButton.textContent = `Resend code in ${this.#resendSecondsRemaining}s`;
        }
        else
        {
            resendButton.disabled = false;
            resendButton.textContent = "Resend code";
        }
    }

    #humaniseRequestError(errorCode, retryAfterSeconds)
    {
        switch (errorCode)
        {
            case "INVALID_EMAIL":
                return "Please enter a valid email address.";
            case "RATE_LIMITED":
                return retryAfterSeconds
                    ? `Please wait ${retryAfterSeconds}s before requesting another code.`
                    : "Please wait a moment before requesting another code.";
            case "EMAIL_DELIVERY_FAILED":
                return "We couldn't send the email. Please try again in a moment.";
            case "ACCESS_NOT_ALLOWED":
                return "This environment is invite-only. Your email isn't on the access list.";
            default:
                return "Couldn't send the code. Please try again.";
        }
    }

    #humaniseVerifyError(errorCode, attemptsRemaining)
    {
        switch (errorCode)
        {
            case "INVALID_CODE":
                return typeof attemptsRemaining === "number"
                    ? `Incorrect code. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} remaining.`
                    : "Incorrect code. Please try again.";
            case "EXPIRED":
                return "Your code expired. Please request a new one.";
            case "TOO_MANY_ATTEMPTS":
                return "Too many incorrect attempts. Please request a new code.";
            case "NAME_REQUIRED":
                return "Please enter your name to create your account.";
            case "INVALID_EMAIL":
                return "That email address looks invalid.";
            case "ACCESS_NOT_ALLOWED":
                return "This environment is invite-only. Your email isn't on the access list.";
            default:
                return "Couldn't verify the code. Please try again.";
        }
    }

    #escapeAttribute(value)
    {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    #escapeText(value)
    {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

customElements.define("email-otp-form", EmailOtpForm);
export default EmailOtpForm;
