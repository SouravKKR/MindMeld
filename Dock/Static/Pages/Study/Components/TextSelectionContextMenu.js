import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";

/**
 * TextSelectionContextMenu
 *
 * Pops up just above the user's selection inside a Study session's
 * card or study-material content and offers two AI-assisted actions:
 *   - Explain (button) — runs the selected text through the LLM.
 *   - Ask (contenteditable + Send) — sends a free-form question
 *     scoped to the selected text.
 *
 * Both actions are placeholder-stubbed via DialogBox.alert until the
 * backend wiring pass.
 *
 * The menu is dismissed by:
 *   - Any pointerdown outside the menu (installed by `create`).
 *   - Escape key.
 *   - The study page's selection watcher detecting a collapsed /
 *     out-of-scope selection.
 *   - The buttons themselves after firing their action.
 *
 * It deliberately overrides ContextMenu.create so the base class's
 * body-click auto-removal (designed for non-interactive context menus)
 * doesn't fire on the very click that finished the selection.
 */
class TextSelectionContextMenu extends ContextMenu
{
    static tagName = "text-selection-context-menu";

    static AI_PLACEHOLDER_TITLE   = "AI feature placeholder";
    static AI_PLACEHOLDER_MESSAGE = "This action will be wired up in a later pass — backend not connected yet.";

    static #ANCHOR_GAP_PX = 8;
    static #VIEWPORT_MARGIN_PX = 8;

    #selectedText               = "";
    #selectionRect              = null;
    #outsidePointerdownHandler  = null;
    #escapeKeydownHandler       = null;
    #sizeObserver               = null;

    static create(selectionRect, selectedText = "")
    {
        this.removeAll();

        const menuElement = document.createElement(TextSelectionContextMenu.tagName);
        menuElement.initialize(selectionRect, selectedText);
        document.body.appendChild(menuElement);

        return menuElement;
    }

    initialize(selectionRect, selectedText = "")
    {
        // Skip super.initialize — it expects a single {x,y} anchor and
        // wires a ResizeObserver that re-runs its own off-viewport
        // correction against that anchor, which fights our anchor-to-
        // selection-rect placement. We replace the positioning machinery
        // entirely below.
        this.classList.add("context-menu");
        this.#selectionRect = selectionRect;
        this.#selectedText = typeof selectedText === "string" ? selectedText : "";
        // Avoid a one-frame flash at (0,0) before #applyPlacement runs.
        this.style.visibility = "hidden";
    }

    getSelectedText()
    {
        return this.#selectedText;
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button
                class="text-selection-explain-button context-menu-item"
                type="button"
            >Explain</button>
            <div class="text-selection-question-row context-menu-item">
                <div
                    class="text-selection-question-input"
                    contenteditable="true"
                    role="textbox"
                    aria-multiline="true"
                    data-placeholder="Ask about this..."
                ></div>
                <button
                    class="text-selection-send-button"
                    type="button"
                    aria-label="Send question"
                >Send</button>
            </div>
        `;

        // Skip super.connectedCallback for the same reason we skip
        // super.initialize — it installs an off-viewport corrector
        // anchored to a single {x,y} that doesn't understand "next to
        // the selection rect". We do the equivalent class tagging here
        // and run our own size-driven re-placement instead.
        this.querySelectorAll(":scope > *").forEach((childElement) =>
        {
            childElement.classList.add("context-menu-item");
        });

        this.#bindLocalEvents();
        this.#bindOutsideDismissHandlers();

        // Initial placement and reveal.
        this.#applyPlacement();
        this.style.visibility = "";

        // Keep the menu adjacent to the selection if its own size changes
        // (e.g. the user types multi-line text into the Ask input).
        this.#sizeObserver = new ResizeObserver(() => this.#applyPlacement());
        this.#sizeObserver.observe(this);
    }

    disconnectedCallback()
    {
        super.disconnectedCallback?.();

        if (this.#sizeObserver)
        {
            this.#sizeObserver.disconnect();
            this.#sizeObserver = null;
        }
        if (this.#outsidePointerdownHandler)
        {
            document.removeEventListener("pointerdown", this.#outsidePointerdownHandler, true);
            this.#outsidePointerdownHandler = null;
        }
        if (this.#escapeKeydownHandler)
        {
            document.removeEventListener("keydown", this.#escapeKeydownHandler, true);
            this.#escapeKeydownHandler = null;
        }
    }

    /**
     * Positions this menu next to the selection rect rather than on top
     * of it. Tries each side in order — below, above, right, left —
     * and uses the first one with enough room. If none fit, falls back
     * to the side with the most space and lets the viewport clamp
     * decide the rest. Re-runs whenever the menu's own size changes.
     */
    #applyPlacement()
    {
        if (!this.#selectionRect)
        {
            return;
        }

        const menuRect       = this.getBoundingClientRect();
        const menuWidth      = menuRect.width;
        const menuHeight     = menuRect.height;
        const viewportWidth  = window.innerWidth;
        const viewportHeight = window.innerHeight;

        const anchorGap      = TextSelectionContextMenu.#ANCHOR_GAP_PX;
        const viewportMargin = TextSelectionContextMenu.#VIEWPORT_MARGIN_PX;

        const selectionRect  = this.#selectionRect;

        const spaceBelow = viewportHeight - selectionRect.bottom - anchorGap - viewportMargin;
        const spaceAbove = selectionRect.top - anchorGap - viewportMargin;
        const spaceRight = viewportWidth  - selectionRect.right  - anchorGap - viewportMargin;
        const spaceLeft  = selectionRect.left - anchorGap - viewportMargin;

        // Returns a candidate {left, top, fits} for the given side.
        const placementFor = (sideName) =>
        {
            if (sideName === "below")
            {
                return {
                    left: selectionRect.left + (selectionRect.width - menuWidth) / 2,
                    top:  selectionRect.bottom + anchorGap,
                    fits: spaceBelow >= menuHeight
                };
            }
            if (sideName === "above")
            {
                return {
                    left: selectionRect.left + (selectionRect.width - menuWidth) / 2,
                    top:  selectionRect.top - menuHeight - anchorGap,
                    fits: spaceAbove >= menuHeight
                };
            }
            if (sideName === "right")
            {
                return {
                    left: selectionRect.right + anchorGap,
                    top:  selectionRect.top + (selectionRect.height - menuHeight) / 2,
                    fits: spaceRight >= menuWidth
                };
            }
            // left
            return {
                left: selectionRect.left - menuWidth - anchorGap,
                top:  selectionRect.top + (selectionRect.height - menuHeight) / 2,
                fits: spaceLeft >= menuWidth
            };
        };

        // First side with enough room wins. Order is intentional:
        // below feels most natural for a reading-flow surface, above
        // is the fallback for selections near the bottom, then either
        // horizontal side.
        const preferredOrder = ["below", "above", "right", "left"];
        let chosen = null;
        for (const sideName of preferredOrder)
        {
            const candidate = placementFor(sideName);
            if (candidate.fits)
            {
                chosen = candidate;
                break;
            }
        }

        if (!chosen)
        {
            // No side has clear space. Pick the side with the largest
            // available gap so the menu overlaps as little of the
            // selection as possible, and let the viewport clamp below
            // pull it back on screen.
            const candidates = preferredOrder.map((sideName) =>
            {
                const space = sideName === "below" ? spaceBelow
                           : sideName === "above" ? spaceAbove
                           : sideName === "right" ? spaceRight
                           : spaceLeft;
                return { sideName, space };
            });
            candidates.sort((firstCandidate, secondCandidate) => secondCandidate.space - firstCandidate.space);
            chosen = placementFor(candidates[0].sideName);
        }

        // Clamp to the viewport so the menu never spills off-screen,
        // even when the chosen side's anchor maths produces a value
        // outside [margin, viewport-size-menu-margin].
        const clampedLeft = Math.max
        (
            viewportMargin,
            Math.min(chosen.left, viewportWidth  - menuWidth  - viewportMargin)
        );
        const clampedTop = Math.max
        (
            viewportMargin,
            Math.min(chosen.top, viewportHeight - menuHeight - viewportMargin)
        );

        this.style.left = `${clampedLeft}px`;
        this.style.top  = `${clampedTop}px`;
    }

    #bindLocalEvents()
    {
        // Clicks / pointerdowns inside the menu must NOT bubble — otherwise
        // the document-level outside-dismiss handler would tear the menu
        // down the moment the user tries to interact with it (e.g. focusing
        // the Ask contenteditable).
        this.addEventListener("pointerdown", (event) =>
        {
            event.stopPropagation();
        });
        this.addEventListener("click", (event) =>
        {
            event.stopPropagation();
        });

        const explainButton   = this.querySelector(".text-selection-explain-button");
        const sendButton      = this.querySelector(".text-selection-send-button");
        const questionInput   = this.querySelector(".text-selection-question-input");

        explainButton.addEventListener("click", async () =>
        {
            await this.#showPlaceholderAlertForAction("Explain", "");
            this.remove();
        });

        sendButton.addEventListener("click", async () =>
        {
            const userQuery = (questionInput?.textContent || "").trim();
            if (userQuery.length === 0)
            {
                await DialogBox.alert("Ask a question", "Type your question first, then press Send.");
                questionInput?.focus();
                return;
            }
            await this.#showPlaceholderAlertForAction("Ask", userQuery);
            this.remove();
        });
    }

    #bindOutsideDismissHandlers()
    {
        this.#outsidePointerdownHandler = (pointerEvent) =>
        {
            if (this.contains(pointerEvent.target))
            {
                return;
            }
            this.remove();
        };

        this.#escapeKeydownHandler = (keyboardEvent) =>
        {
            if (keyboardEvent.key === "Escape")
            {
                this.remove();
            }
        };

        // Capture phase so we beat any other handler that might
        // stopPropagation on outside elements.
        document.addEventListener("pointerdown", this.#outsidePointerdownHandler, true);
        document.addEventListener("keydown", this.#escapeKeydownHandler, true);
    }

    async #showPlaceholderAlertForAction(actionLabel, userQuery)
    {
        const truncatedSelection = this.#selectedText.length > 200
            ? this.#selectedText.substring(0, 200) + "…"
            : this.#selectedText;

        const bodyLines = [
            `${actionLabel} — ${TextSelectionContextMenu.AI_PLACEHOLDER_MESSAGE}`,
            "",
            `Selected text: "${truncatedSelection}"`,
        ];

        if (userQuery.length > 0)
        {
            bodyLines.push(`Your question: ${userQuery}`);
        }

        await DialogBox.alert(TextSelectionContextMenu.AI_PLACEHOLDER_TITLE, bodyLines.join("\n"));
    }
}

customElements.define(TextSelectionContextMenu.tagName, TextSelectionContextMenu);
export default TextSelectionContextMenu;
