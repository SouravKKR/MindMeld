import ScreenshotDetector from "./ScreenshotDetector.js";

/**
 * PaidDeckCopyGuard
 *
 * Makes bulk-copying a purchased deck's content annoying enough not to be worth
 * it, without breaking the features a learner legitimately needs.
 *
 * This is DETERRENCE, not protection. Anyone with devtools can read the DOM,
 * and no browser API can stop an OS-level screenshot. What this does stop is
 * the low-effort path: select-all, copy, paste into a document, repeat. Raw
 * text without the deck structure is of little use anyway — a copier still has
 * to rebuild every card by hand.
 *
 * ── What is blocked, and what deliberately is not ──────────────────────────
 *
 *   BLOCKED: copy, cut, drag-out, right-click menu, and the Ctrl/Cmd+C / +X /
 *            +A shortcuts while the pointer or caret is inside paid content.
 *   ALLOWED: text SELECTION, and paste.
 *
 * Selection is deliberately left working. Setting `user-select: none` — the
 * obvious blunt instrument — would break two real features: Ask AI's
 * selected-text flow (TextSelectionContextMenu passes the learner's highlighted
 * phrase to the prompt as its topic signal) and editing itself, which is
 * unusable without being able to select. Blocking the copy ACTION rather than
 * the selection keeps both intact and stops the clipboard just the same.
 *
 * Paste is untouched: a learner pasting their own notes INTO a card they bought
 * is exactly the editing workflow the overlay feature exists to support.
 *
 * Screenshot heuristics (blur-on-PrintScreen, capture telemetry) live in
 * ScreenshotDetector; this class registers containers with it so the two travel
 * together and a caller only has to know about one of them.
 */
class PaidDeckCopyGuard
{
    static CONTAINER_CLASS = "paid-deck-protected-content";

    static #registeredContainers = new Set();
    static #bDocumentListenersBound = false;

    /**
     * Starts protecting a container holding paid content. Idempotent per
     * element, so a re-render that registers the same node again is free.
     *
     * @param {HTMLElement} container the element wrapping the paid content
     * @param {string} deckId the paid deck id, for capture telemetry
     * @param {string} entityId the card / material on screen, for telemetry
     */
    static registerContainer(container, deckId, entityId)
    {
        if (!container || PaidDeckCopyGuard.#registeredContainers.has(container))
        {
            return;
        }

        container.classList.add(PaidDeckCopyGuard.CONTAINER_CLASS);
        PaidDeckCopyGuard.#registeredContainers.add(container);
        PaidDeckCopyGuard.#ensureDocumentListenersBound();

        // Blur-on-capture + the /PaidDecks/ScreenshotAttempt telemetry.
        ScreenshotDetector.registerContainer(container, deckId, entityId);
    }

    static unregisterContainer(container)
    {
        if (!container)
        {
            return;
        }

        container.classList.remove(PaidDeckCopyGuard.CONTAINER_CLASS);
        PaidDeckCopyGuard.#registeredContainers.delete(container);
        ScreenshotDetector.unregisterContainer(container);
    }

    static unregisterAll()
    {
        for (const container of Array.from(PaidDeckCopyGuard.#registeredContainers))
        {
            PaidDeckCopyGuard.unregisterContainer(container);
        }
    }

    /**
     * Whether an event originated inside protected content. Uses composedPath
     * so a click inside a shadow root still resolves to its host container.
     */
    static #isInsideProtectedContent(browserEvent)
    {
        if (PaidDeckCopyGuard.#registeredContainers.size === 0)
        {
            return false;
        }

        const eventPath = typeof browserEvent.composedPath === "function" ? browserEvent.composedPath() : [];
        for (const pathEntry of eventPath)
        {
            if (PaidDeckCopyGuard.#registeredContainers.has(pathEntry))
            {
                return true;
            }
        }

        const eventTarget = browserEvent.target;
        for (const container of PaidDeckCopyGuard.#registeredContainers)
        {
            if (eventTarget instanceof Node && container.contains(eventTarget))
            {
                return true;
            }
        }

        return false;
    }

    /**
     * Whether the current text selection lies inside protected content. A
     * keyboard copy has no useful event target — the shortcut fires on whatever
     * holds focus — so the selection is what decides.
     */
    static #isSelectionInsideProtectedContent()
    {
        if (PaidDeckCopyGuard.#registeredContainers.size === 0)
        {
            return false;
        }

        const currentSelection = window.getSelection ? window.getSelection() : null;
        if (!currentSelection || currentSelection.rangeCount === 0)
        {
            return false;
        }

        const selectionAnchor = currentSelection.anchorNode;
        if (!selectionAnchor)
        {
            return false;
        }

        for (const container of PaidDeckCopyGuard.#registeredContainers)
        {
            if (container.contains(selectionAnchor))
            {
                return true;
            }
        }

        return false;
    }

    static #ensureDocumentListenersBound()
    {
        if (PaidDeckCopyGuard.#bDocumentListenersBound)
        {
            return;
        }
        PaidDeckCopyGuard.#bDocumentListenersBound = true;

        // Capture phase throughout, so the block lands before any component's
        // own handler (and before a rich-text editor's) can act on the event.
        for (const blockedEventName of ["copy", "cut", "dragstart"])
        {
            document.addEventListener(blockedEventName, (browserEvent) =>
            {
                if (PaidDeckCopyGuard.#isInsideProtectedContent(browserEvent) || PaidDeckCopyGuard.#isSelectionInsideProtectedContent())
                {
                    browserEvent.preventDefault();
                    browserEvent.stopPropagation();
                }
            }, true);
        }

        document.addEventListener("contextmenu", (browserEvent) =>
        {
            if (PaidDeckCopyGuard.#isInsideProtectedContent(browserEvent))
            {
                browserEvent.preventDefault();
            }
        }, true);

        document.addEventListener("keydown", (keyboardEvent) =>
        {
            if (!(keyboardEvent.ctrlKey || keyboardEvent.metaKey))
            {
                return;
            }

            const pressedKey = String(keyboardEvent.key || "").toLowerCase();
            // "a" is included so select-all-then-copy is not a one-keystroke
            // way around the copy block. Paste is deliberately absent.
            if (pressedKey !== "c" && pressedKey !== "x" && pressedKey !== "a")
            {
                return;
            }

            if (PaidDeckCopyGuard.#isInsideProtectedContent(keyboardEvent) || PaidDeckCopyGuard.#isSelectionInsideProtectedContent())
            {
                keyboardEvent.preventDefault();
            }
        }, true);
    }
}

export default PaidDeckCopyGuard;
