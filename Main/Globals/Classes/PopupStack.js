/**
 * PopupStack
 *
 * A session-wide, last-in-first-out registry of the popups, dialogs,
 * overlays and menus that are currently on screen. It exists so a single
 * global key handler (KeyboardEvents) can answer one question — "is a
 * popup open, and if so how should Escape treat it?" — without every popup
 * having to fight the global back-navigation itself.
 *
 * Before this registry, the global Escape handler always called
 * history.back(), so pressing Escape while a popup was open navigated the
 * page away (and, for popups that also self-closed on Escape, did both).
 * Now the global handler asks the stack first: while any popup is
 * registered Escape dismisses the top-most one instead of navigating.
 *
 * Two kinds of entry:
 *   - dismissible (the default): Escape runs the entry's dismiss callback,
 *     which closes that popup. The popup's own close path unregisters it.
 *   - non-dismissible: a blocking overlay (initialization / forced sync)
 *     that must not be closed by the user. Escape is swallowed — neither
 *     navigation nor dismissal happens — until the overlay clears itself.
 */
class PopupStack
{
    static #entries = [];

    /**
     * Register an on-screen popup. Returns an opaque handle that must be
     * passed to unregister() when the popup closes.
     *
     * @param {{ dismiss?: function, dismissible?: boolean | function }} options
     *   dismiss — called when Escape targets this popup while it is top of
     *     the stack. Responsible for closing the popup.
     *   dismissible — false (or a function returning false) marks a
     *     blocking overlay whose Escape is swallowed rather than dismissed.
     *     May be a function so the value can be read live at Escape time.
     */
    static register(options = {})
    {
        const entry =
        {
            dismiss: typeof options.dismiss === "function" ? options.dismiss : null,
            dismissible: options.dismissible === undefined ? true : options.dismissible
        };
        PopupStack.#entries.push(entry);
        return entry;
    }

    static unregister(handle)
    {
        const entryIndex = PopupStack.#entries.indexOf(handle);
        if (entryIndex !== -1)
        {
            PopupStack.#entries.splice(entryIndex, 1);
        }
    }

    static hasOpenPopup()
    {
        return PopupStack.#entries.length > 0;
    }

    /**
     * Called by the global Escape handler. Returns true when a popup
     * absorbs the keypress (so the caller must NOT navigate back), and
     * false when the stack is empty (the caller is free to navigate).
     */
    static handleEscape()
    {
        if (PopupStack.#entries.length === 0)
        {
            return false;
        }

        const topEntry = PopupStack.#entries[PopupStack.#entries.length - 1];

        if (PopupStack.#resolveDismissible(topEntry))
        {
            if (topEntry.dismiss !== null)
            {
                topEntry.dismiss();
            }

            // A well-behaved dismiss unregisters this entry through the
            // popup's own close path. Drop it defensively anyway so a second
            // Escape can never re-target an already-dismissed popup.
            PopupStack.unregister(topEntry);
        }

        return true;
    }

    static #resolveDismissible(entry)
    {
        if (typeof entry.dismissible === "function")
        {
            return entry.dismissible() !== false;
        }
        return entry.dismissible !== false;
    }
}

export default PopupStack;
