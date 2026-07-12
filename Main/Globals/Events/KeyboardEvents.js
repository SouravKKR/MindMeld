import PopupStack from "../Classes/PopupStack.js";

class KeyboardEvents
{
    static
    {
        window.addEventListener("keydown", (event) =>
        {
            if (event.key !== "Escape")
            {
                return;
            }

            // A popup owns Escape whenever one is open: dismiss the top-most
            // popup instead of navigating back. This runs before the text-
            // field exception below on purpose — Escape inside a dialog's own
            // input (a password prompt, a search box) should close the dialog,
            // not merely blur the field.
            if (PopupStack.handleEscape())
            {
                return;
            }

            // No popup open: Esc inside a text input / textarea /
            // contenteditable cell is a canonical "cancel edit / blur"
            // gesture — don't hijack it for navigation. The form control's
            // own handler decides what to do.
            const eventTarget = event.target;
            if (eventTarget && typeof eventTarget.matches === "function"
                && eventTarget.matches("input, textarea, [contenteditable=\"true\"], [contenteditable=\"\"]"))
            {
                return;
            }

            // Route through the browser history so popstate is the single
            // back code path — PageNavigator.#handlePopState then chooses
            // between in-stack pop and HARDWARE_BACK_AT_ROOT. This keeps
            // Esc and browser-back behaviourally identical, including the
            // sentinel re-push that traps the user inside the SPA.
            window.history.back();
        });
    }
}

export default KeyboardEvents;
