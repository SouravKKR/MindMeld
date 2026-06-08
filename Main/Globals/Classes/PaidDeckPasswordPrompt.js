import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckSession from "./Crypto/PaidDeckSession.js";

/**
 * PaidDeckPasswordPrompt
 *
 * Modal that collects the buyer's paid-deck password and feeds it to
 * PaidDeckSession.unlock() until the unlock succeeds or the user
 * cancels. Used in two modes:
 *   - `show(deckId)` — unlock path (default)
 *   - `showSetupPrompt()` — set initial password (returns the plaintext
 *     so the caller can POST it to /PaidDecks/SetPassword once)
 *
 * The password string is never written anywhere besides the (passed by
 * reference) call into PaidDeckSession — no logging, no event payload.
 */
class PaidDeckPasswordPrompt
{
    static async show(deckId)
    {
        return await new Promise((resolveCaller) =>
        {
            const dialog = DialogBox.modal(`
                <div class="paid-deck-password-prompt">
                    <h2 class="paid-deck-password-prompt-title">Unlock paid deck</h2>
                    <p class="paid-deck-password-prompt-message">
                        Enter your paid-deck password to decrypt this deck for the rest of this browser session.
                    </p>
                    <input type="password" class="paid-deck-password-prompt-input" autocomplete="current-password">
                    <div class="paid-deck-password-prompt-error" data-role="prompt-error" hidden></div>
                    <div class="paid-deck-password-prompt-actions">
                        <button type="button" class="paid-deck-password-prompt-cancel">Cancel</button>
                        <button type="button" class="paid-deck-password-prompt-submit">Unlock</button>
                    </div>
                </div>
            `);

            const passwordInput = dialog.querySelector(".paid-deck-password-prompt-input");
            const errorElement = dialog.querySelector('[data-role="prompt-error"]');
            const submitButton = dialog.querySelector(".paid-deck-password-prompt-submit");
            const cancelButton = dialog.querySelector(".paid-deck-password-prompt-cancel");

            passwordInput.focus();

            const finalize = (result) =>
            {
                dialog.close();
                resolveCaller(result);
            };

            cancelButton.addEventListener("click", () => finalize({ confirmed: false }));

            const tryUnlock = async () =>
            {
                errorElement.hidden = true;
                errorElement.textContent = "";

                const submittedPassword = passwordInput.value;
                if (submittedPassword.length === 0)
                {
                    errorElement.textContent = "Enter a password.";
                    errorElement.hidden = false;
                    return;
                }

                submitButton.disabled = true;
                submitButton.textContent = "Unlocking…";

                const unlockResult = await PaidDeckSession.unlock(deckId, submittedPassword);

                if (unlockResult.success)
                {
                    finalize({ confirmed: true, contentKeyVersion: unlockResult.contentKeyVersion });
                    return;
                }

                errorElement.textContent = PaidDeckPasswordPrompt.#labelForError(unlockResult.error);
                errorElement.hidden = false;
                submitButton.disabled = false;
                submitButton.textContent = "Unlock";
                passwordInput.select();
            };

            submitButton.addEventListener("click", tryUnlock);
            passwordInput.addEventListener("keydown", (keyDownEvent) =>
            {
                if (keyDownEvent.key === "Enter")
                {
                    tryUnlock();
                }
            });
        });
    }

    static async showSetupPrompt()
    {
        return await new Promise((resolveCaller) =>
        {
            const dialog = DialogBox.modal(`
                <div class="paid-deck-password-prompt">
                    <h2 class="paid-deck-password-prompt-title">Set paid-deck password</h2>
                    <p class="paid-deck-password-prompt-message">
                        Choose a password to protect every paid deck you'll own. You'll be asked
                        for it once each browser session — and we can't recover it for you, so
                        keep it somewhere safe.
                    </p>
                    <input type="password" class="paid-deck-password-prompt-input" placeholder="New password" autocomplete="new-password">
                    <input type="password" class="paid-deck-password-prompt-confirm" placeholder="Confirm password" autocomplete="new-password">
                    <div class="paid-deck-password-prompt-error" data-role="prompt-error" hidden></div>
                    <div class="paid-deck-password-prompt-actions">
                        <button type="button" class="paid-deck-password-prompt-cancel">Skip for now</button>
                        <button type="button" class="paid-deck-password-prompt-submit">Save password</button>
                    </div>
                </div>
            `);

            const passwordInput = dialog.querySelector(".paid-deck-password-prompt-input");
            const confirmInput = dialog.querySelector(".paid-deck-password-prompt-confirm");
            const errorElement = dialog.querySelector('[data-role="prompt-error"]');
            const submitButton = dialog.querySelector(".paid-deck-password-prompt-submit");
            const cancelButton = dialog.querySelector(".paid-deck-password-prompt-cancel");

            passwordInput.focus();

            const finalize = (result) =>
            {
                dialog.close();
                resolveCaller(result);
            };

            cancelButton.addEventListener("click", () => finalize({ confirmed: false }));
            submitButton.addEventListener("click", () =>
            {
                errorElement.hidden = true;

                const passwordValue = passwordInput.value;
                const confirmValue = confirmInput.value;

                if (passwordValue.length < 6)
                {
                    errorElement.textContent = "Password must be at least 6 characters.";
                    errorElement.hidden = false;
                    return;
                }
                if (passwordValue !== confirmValue)
                {
                    errorElement.textContent = "Passwords do not match.";
                    errorElement.hidden = false;
                    return;
                }
                finalize({ confirmed: true, password: passwordValue });
            });
        });
    }

    static #labelForError(errorCode)
    {
        switch (errorCode)
        {
            case "WRONG_PASSWORD":      return "That password is wrong.";
            case "NO_ACTIVE_LICENSE":   return "You don't have an active license for this deck.";
            case "PASSWORD_NOT_SET":    return "You haven't set a paid-deck password yet.";
            case "UNWRAP_FAILED":       return "Couldn't decrypt the deck with that password.";
            default:                    return errorCode || "Unlock failed.";
        }
    }
}

export default PaidDeckPasswordPrompt;
