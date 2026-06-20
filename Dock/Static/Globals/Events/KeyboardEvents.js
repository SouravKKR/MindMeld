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

            // Esc inside a text input / textarea / contenteditable cell is a
            // canonical "cancel edit / blur" gesture — don't hijack it for
            // navigation. The form control's own handler decides what to do.
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
