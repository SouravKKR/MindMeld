import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckSession from "./Crypto/PaidDeckSession.js";

/**
 * PaidDeckPasswordPrompt
 *
 * Modal that collects the buyer's paid-deck password and feeds it to
 * PaidDeckSession.unlock() until the unlock succeeds or the user
 * cancels. Used in two modes:
 *   - `show(deckId)` — unlock path (default). Cancellable: the deck is
 *     already openable once the right password is entered, so backing
 *     out costs the user nothing they cannot recover.
 *   - `showSetupPrompt()` — set initial password. NOT cancellable, and
 *     it resolves only with a password (returns the plaintext so the
 *     caller can POST it to /PaidDecks/SetPassword once).
 *
 * The password string is never written anywhere besides the (passed by
 * reference) call into PaidDeckSession — no logging, no event payload.
 */
class PaidDeckPasswordPrompt
{
    // Mirrors the floor the /PaidDecks/SetPassword endpoint enforces. Stated
    // here so the message names the same number the server would refuse on.
    static MINIMUM_PASSWORD_LENGTH = 6;

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

            // Escape / the dialog X must resolve the awaited promise (as a
            // cancel) rather than just removing the dialog and hanging the
            // caller — its cancel button isn't a generic .cancel-button.
            dialog.setDismissHandler(() => finalize({ confirmed: false }));

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
                    <p class="paid-deck-password-prompt-message">
                        Your decks stay locked until this is set, so it has to be done now.
                    </p>
                    <input type="password" class="paid-deck-password-prompt-input" placeholder="New password" autocomplete="new-password">
                    <input type="password" class="paid-deck-password-prompt-confirm" placeholder="Confirm password" autocomplete="new-password">
                    <div class="paid-deck-password-prompt-error" data-role="prompt-error" hidden></div>
                    <div class="paid-deck-password-prompt-actions">
                        <button type="button" class="paid-deck-password-prompt-submit">Save password</button>
                    </div>
                </div>
            `);

            // There is deliberately no way out of this dialog. The password is
            // what derives the key that unwraps every owned deck's content key,
            // so a buyer who leaves without setting one owns decks that nothing
            // in the app can open and offers no route back to this prompt — the
            // "Skip for now" button was a one-way door into that state. Escape,
            // the backdrop and the corner X are all removed for the same reason;
            // the only exit is a password.
            dialog.setDismissible(false);
            dialog.querySelector(".close-button")?.remove();

            const passwordInput = dialog.querySelector(".paid-deck-password-prompt-input");
            const confirmInput = dialog.querySelector(".paid-deck-password-prompt-confirm");
            const errorElement = dialog.querySelector('[data-role="prompt-error"]');
            const submitButton = dialog.querySelector(".paid-deck-password-prompt-submit");

            passwordInput.focus();

            const finalize = (result) =>
            {
                dialog.close();
                resolveCaller(result);
            };

            const trySave = () =>
            {
                errorElement.hidden = true;

                const passwordValue = passwordInput.value;
                const confirmValue = confirmInput.value;

                if (passwordValue.length < PaidDeckPasswordPrompt.MINIMUM_PASSWORD_LENGTH)
                {
                    errorElement.textContent = `Password must be at least ${PaidDeckPasswordPrompt.MINIMUM_PASSWORD_LENGTH} characters.`;
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
            };

            submitButton.addEventListener("click", trySave);

            for (const inputElement of [passwordInput, confirmInput])
            {
                inputElement.addEventListener("keydown", (keyDownEvent) =>
                {
                    if (keyDownEvent.key === "Enter")
                    {
                        trySave();
                    }
                });
            }
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
