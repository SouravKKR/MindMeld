import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckPasswordPrompt from "./PaidDeckPasswordPrompt.js";

/**
 * PaidDeckPasswordSetup
 *
 * The one place that turns "this account has no paid-deck password yet" into
 * "it has one now": raise the setup prompt, POST the chosen password to
 * /PaidDecks/SetPassword, and report whether it stuck.
 *
 * It exists as its own class because two very different moments need it and
 * must behave identically at both:
 *
 *   - straight after a purchase (PaidDeckPurchaseFlow), which is where the
 *     server asks for it via `requiresPasswordSetup`, and
 *   - the first time a deck is opened without one (PaidDeckStudyGate), which
 *     is the recovery route for every account that reached that state before
 *     the prompt became mandatory.
 *
 * Without the second caller the fix would only cover purchases made from this
 * build onwards; accounts already holding decks and no password would stay
 * locked out permanently, since nothing else in the app raises this prompt.
 *
 * The plaintext is returned to the caller so it can pre-unlock the session
 * immediately rather than asking for the same password twice in a row. It is
 * never logged and never put on an event payload.
 */
class PaidDeckPasswordSetup
{
    static #SET_PASSWORD_ENDPOINT = "/PaidDecks/SetPassword";

    /**
     * Prompts for a new paid-deck password and registers it server-side.
     *
     * The prompt itself cannot be dismissed, so this only returns once the user
     * has supplied a password — `succeeded` reports whether the server accepted
     * it, not whether the user engaged.
     *
     * @returns {Promise<{succeeded: boolean, password?: string}>}
     */
    static async run()
    {
        const promptResult = await PaidDeckPasswordPrompt.showSetupPrompt();

        // Defensive: showSetupPrompt has no cancel path today, but a caller
        // reading `succeeded` must not be handed a password that isn't there.
        if (!promptResult || promptResult.confirmed !== true)
        {
            return { succeeded: false };
        }

        try
        {
            const setupResponse = await fetch(PaidDeckPasswordSetup.#SET_PASSWORD_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: promptResult.password })
            });

            if (!setupResponse.ok)
            {
                const errorJson = await setupResponse.json().catch(() => ({}));
                await DialogBox.alert("Password setup failed", errorJson.error || `HTTP ${setupResponse.status}`);
                return { succeeded: false };
            }

            return { succeeded: true, password: promptResult.password };
        }
        catch (setupError)
        {
            await DialogBox.alert("Password setup failed", setupError.message);
            return { succeeded: false };
        }
    }
}

export default PaidDeckPasswordSetup;
