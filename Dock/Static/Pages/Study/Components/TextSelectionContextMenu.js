import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import LlmTierSelect from "../../../CommonComponents/LlmTierSelect.js";
import { modelTiers } from "../../../Globals/Enumerations/ModelTiers.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import ModelTierMetadata from "../../../Globals/Constants/ModelTierMetadata.js";
import InformationSourceSelector from "../../AutomaticGeneration/Components/InformationSourceSelector.js";
import ExtractableInformationSource from "../../../Globals/Classes/Decorators/ExtractableInformationSource.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import BrowserLlmDownloadConstants from "../../../Globals/Constants/BrowserLlmDownloadConstants.js";
import Deck from "../../../Globals/Model/Deck.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";
import AskAiSession from "../Classes/AskAiSession.js";
import AskAiImageAttachmentManager from "../Classes/AskAiImageAttachmentManager.js";
import EnhanceFlow from "../Classes/EnhanceFlow.js";

/**
 * TextSelectionContextMenu
 *
 * Pops up just above the user's selection inside a Study session's
 * card or study-material content and offers two AI-assisted actions:
 *   - Explain (button) — runs the selected text through the LLM.
 *   - Ask (contenteditable + Send) — sends a free-form question
 *     scoped to the selected text.
 *
 * For non-Free tiers, two additional opt-ins are surfaced:
 *   - "Use Information Sources" — when checked, the LLM prompt is
 *     grounded against information sources the user attaches inline
 *     (reusing the AutomaticGeneration page's <information-source-selector>,
 *     filtered to hide CURRICULUM_OR_SYLLABUS which is irrelevant to
 *     a per-selection ask). Disables Explain/Send until at least one
 *     source is present. The Python worker runs a top-k vector search
 *     over chunks indexed by PrepareForSimilaritySearch and inlines
 *     them into the prompt as TEXT — the sources are never uploaded.
 *   - "Include images from sources" — uses the same source list, but
 *     opts the response into multimodal grounding. Image sources are
 *     not chosen separately because per-image picking would overwhelm
 *     the small menu.
 *
 * Both grounding state and the source list are persisted on the deck
 * being studied via `Deck.additionalData.askAiPreferences`, so the
 * configuration sticks across selections and rides the standard deck
 * sync pipeline. Unchecking the toggle hides the source UI but retains
 * the sources on disk — re-checking later restores them.
 *
 * Image attachments (the "+" button + paste-image interception) are
 * per-prompt and never persisted — see AskAiImageAttachmentManager.
 * They go directly to Gemini as multimodal parts.
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

    static AI_FREE_TIER_TITLE   = "Free tier unavailable";
    static AI_FREE_TIER_MESSAGE = "The Free tier is offline-only and not wired for streaming yet. Pick Basic, Pro, or Pro Plus.";

    static #ANCHOR_GAP_PX = 8;
    static #VIEWPORT_MARGIN_PX = 8;

    // Persisted under deck.additionalData[this key]. Single sub-object
    // so all ask-AI prefs sync as one unit. Shared with
    // Deck.getExportData (which strips this key on export) — the
    // canonical name lives in BrowserLlmDownloadConstants.
    static #ADDITIONAL_DATA_KEY = BrowserLlmDownloadConstants.DECK_PREFERENCES_FIELD_KEY;

    // Surfaces the document-grounding controls only on tiers that
    // actually call the cloud — the in-browser Free model is offline
    // and doesn't ground against the user's sources this round.
    static #TIERS_THAT_SUPPORT_GROUNDING = new Set([
        modelTiers.BASIC,
        modelTiers.PRO,
        modelTiers.PRO_PLUS,
    ]);

    // Tracks the currently-displayed Card / StudyMaterial via the
    // StudySessionEvents the session dispatches. The menu uses these
    // when building the AskAi request payload. Stored as class statics
    // so the window listeners (installed once at module-load time,
    // below customElements.define) can update them without holding a
    // reference to a specific menu instance — the menu reads them on
    // the click path.
    //
    // Module-load install is critical: the menu only mounts when the
    // user selects text, but the StudySession that dispatches
    // CARD_CHANGED / STUDY_MATERIAL_CHANGED has already started by
    // then. A connectedCallback-time listener would miss those events
    // and the menu would never know which entity is in view.
    static #currentCard = null;
    static #currentStudyMaterial = null;

    #selectedText = "";
    #selectionRect = null;
    #outsidePointerdownHandler = null;
    #escapeKeydownHandler = null;
    #sizeObserver = null;
    #studyDeck = null;
    #boundTierSelectedHandler = null;
    #boundSourcesChangedHandler = null;
    #imageAttachmentManager = null;

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
        // The deck being studied — used as the persistence scope for
        // the ask-AI prefs. setCurrentDeck is called by HomePage when
        // entering a deck, so by the time a study session is running
        // it already points at the right deck (i.e. the deck the user
        // clicked Study on, NOT the leaf card / study-material).
        this.#studyDeck = Deck.getCurrentDeck();

        this.innerHTML =
        `
            <button
                class="text-selection-explain-button context-menu-item"
                type="button"
            >Explain</button>
            <button
                class="text-selection-enhance-button context-menu-item"
                type="button"
            >Enhance</button>
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
            <div class="text-selection-divider" role="separator"></div>
            <div class="text-selection-tier-row context-menu-item">
                <llm-tier-select></llm-tier-select>
            </div>
            <div class="text-selection-grounding-controls context-menu-item" data-role="grounding-controls" hidden>
                <label class="text-selection-grounding-checkbox-row">
                    <input type="checkbox" data-role="document-grounded-checkbox">
                    <span class="text-selection-grounding-label">Use Information Sources</span>
                    <span class="text-selection-grounding-hint">slight extra cost</span>
                </label>
                <div class="text-selection-grounding-sources" data-role="grounding-sources" hidden>
                    <information-source-selector exclude-types="CURRICULUM_OR_SYLLABUS"></information-source-selector>
                    <label class="text-selection-grounding-checkbox-row">
                        <input type="checkbox" data-role="include-images-checkbox">
                        <span class="text-selection-grounding-label">Include images from sources</span>
                    </label>
                </div>
            </div>
            <div class="text-selection-divider" role="separator"></div>
            <button
                class="text-selection-copy-button context-menu-item"
                type="button"
            >Copy</button>
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
        this.#bindGroundingEvents();
        this.#hydrateGroundingFromDeck();
        this.#mountImageAttachmentManager();
        this.#applyTierAwareVisibility();
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
        if (this.#boundTierSelectedHandler)
        {
            // The select lives inside this; it's about to be removed
            // along with this element, but detach explicitly for tidiness.
            const tierSelect = this.querySelector("llm-tier-select");
            tierSelect?.removeEventListener("tier-selected", this.#boundTierSelectedHandler);
            this.#boundTierSelectedHandler = null;
        }
        if (this.#boundSourcesChangedHandler)
        {
            const sourceSelectorElement = this.querySelector("information-source-selector");
            sourceSelectorElement?.removeEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, this.#boundSourcesChangedHandler);
            this.#boundSourcesChangedHandler = null;
        }
        if (this.#imageAttachmentManager)
        {
            this.#imageAttachmentManager.detach();
            this.#imageAttachmentManager = null;
        }
    }

    /**
     * Public setters used by the module-level listener bootstrap below.
     * Kept on the class so a future caller (e.g. the bottom panel) can
     * push the active entity in if it ever needs to. Pairing the
     * setters means the listener block at module bottom doesn't need
     * to reach into private static state.
     */
    static setCurrentCard(card)
    {
        TextSelectionContextMenu.#currentCard = card;
        // Switching to a card means we're no longer on a study
        // material — clear the other slot so a stale reference can't
        // leak into a subsequent CARD-mode payload.
        TextSelectionContextMenu.#currentStudyMaterial = null;
    }

    static setCurrentStudyMaterial(studyMaterial)
    {
        TextSelectionContextMenu.#currentStudyMaterial = studyMaterial;
        TextSelectionContextMenu.#currentCard = null;
    }

    /**
     * Mount the image-attach manager into the Ask row. The "+" button
     * and thumbnail strip stay hidden for tiers without image-input
     * support — gated below in #applyTierAwareVisibility.
     */
    #mountImageAttachmentManager()
    {
        const questionRow = this.querySelector(".text-selection-question-row");
        const questionInputElement = this.querySelector(".text-selection-question-input");
        if (!questionRow || !questionInputElement)
        {
            return;
        }
        this.#imageAttachmentManager = new AskAiImageAttachmentManager(questionRow, questionInputElement);
        this.#imageAttachmentManager.mount();
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
        const enhanceButton   = this.querySelector(".text-selection-enhance-button");
        const sendButton      = this.querySelector(".text-selection-send-button");
        const questionInput   = this.querySelector(".text-selection-question-input");
        const copyButton = this.querySelector(".text-selection-copy-button");

        const tierSelect = this.querySelector("llm-tier-select");

        // Re-render the grounding controls' visibility on each tier
        // change. The selection itself persists via the select's own
        // event flow; this handler just keeps the menu in sync.
        this.#boundTierSelectedHandler = () =>
        {
            this.#applyTierAwareVisibility();
        };
        tierSelect?.addEventListener("tier-selected", this.#boundTierSelectedHandler);

        explainButton.addEventListener("click", async () =>
        {
            const chosenTier = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;
            if (!await this.#validateBeforeProceeding(chosenTier))
            {
                return;
            }
            await this.#dispatchAskAiSession(askAiPromptModes.EXPLAIN, null, chosenTier);
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
            const chosenTier = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;
            if (!await this.#validateBeforeProceeding(chosenTier))
            {
                return;
            }
            await this.#dispatchAskAiSession(askAiPromptModes.ASK, userQuery, chosenTier);
            this.remove();
        });

        enhanceButton?.addEventListener("click", async () =>
        {
            // Validate the tier + grounding state BEFORE opening the
            // picker so the user doesn't pick a tool and only then
            // discover they need to add a source. Same gate the
            // Explain / Send buttons run.
            const chosenTier = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;
            if (!await this.#validateBeforeProceeding(chosenTier))
            {
                return;
            }

            const choice = await EnhanceFlow.open({ selectedText: this.#selectedText });
            if (!choice)
            {
                return;
            }

            // Forward the selected text via the existing dispatch
            // helper — it pulls this.#selectedText into the AskAiSession
            // payload, which the server's prompt builder routes to the
            // SELECTION-variant template for GIVE_EXAMPLES / GLOSSARY /
            // MAKE_MNEMONIC. FORMAT stays whole-entity at the builder
            // level even when invoked from here; that's intentional —
            // re-formatting a single fragment out of context is not a
            // useful operation.
            const instructions = choice.instructions.length > 0 ? choice.instructions : null;
            await this.#dispatchAskAiSession(choice.promptModeValue, instructions, chosenTier);
            this.remove();
        });

        copyButton.addEventListener("click", async () =>
        {
            await this.#copySelectedTextToClipboard();
            this.remove();
        });
    }

    /**
     * Copy the currently-selected text via the Clipboard API, falling
     * back to the legacy execCommand path for environments where the
     * async API is unavailable (older browsers, non-secure-context
     * dev). We have the selection in #selectedText already, so we
     * never need to touch window.getSelection here.
     */
    async #copySelectedTextToClipboard()
    {
        const textToCopy = this.#selectedText || "";
        if (textToCopy.length === 0)
        {
            return;
        }

        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function")
        {
            try
            {
                await navigator.clipboard.writeText(textToCopy);
                return;
            }
            catch (clipboardError)
            {
                console.warn(`[TextSelectionContextMenu] Clipboard API write failed; falling back to execCommand. ${clipboardError?.message || clipboardError}`);
            }
        }

        // Legacy fallback: drop the text into an off-screen textarea,
        // select it, execCommand("copy"), then remove the helper.
        const helperTextarea = document.createElement("textarea");
        helperTextarea.value = textToCopy;
        helperTextarea.setAttribute("readonly", "");
        helperTextarea.style.position = "fixed";
        helperTextarea.style.top = "-1000px";
        helperTextarea.style.left = "-1000px";
        document.body.appendChild(helperTextarea);
        helperTextarea.select();
        try
        {
            document.execCommand("copy");
        }
        catch (legacyCopyError)
        {
            console.warn(`[TextSelectionContextMenu] execCommand copy fallback failed. ${legacyCopyError?.message || legacyCopyError}`);
        }
        helperTextarea.remove();
    }

    #bindOutsideDismissHandlers()
    {
        // Tolerate clicks inside transient chrome that semantically
        // belongs to this menu but renders OUTSIDE its DOM subtree —
        // any dialog the inline InformationSourceUploader may raise
        // (file picker is native and doesn't fire DOM events, but a
        // future upload dialog would). The tier picker is now a
        // native <select>, whose dropdown is browser chrome (not DOM)
        // and never triggers a document-level pointerdown.
        const bClickInsideTransientChrome = (clickedElement) =>
        {
            if (!clickedElement) return false;
            if (typeof clickedElement.closest !== "function") return false;
            return Boolean(
                clickedElement.closest("dialog-box")
             || clickedElement.closest(".dialog-backdrop")
            );
        };

        this.#outsidePointerdownHandler = (pointerEvent) =>
        {
            if (this.contains(pointerEvent.target))
            {
                return;
            }
            if (bClickInsideTransientChrome(pointerEvent.target))
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

    /**
     * Wire the document-grounding + include-images checkboxes + the
     * inline information-source-selector. Each user change persists
     * to the deck's additionalData and triggers a deck.save() so the
     * choice rides the standard sync pipeline.
     */
    #bindGroundingEvents()
    {
        const groundingControlsElement = this.querySelector('[data-role="grounding-controls"]');
        const groundingSourcesElement = this.querySelector('[data-role="grounding-sources"]');
        const groundedCheckbox = this.querySelector('[data-role="document-grounded-checkbox"]');
        const includeImagesCheckbox = this.querySelector('[data-role="include-images-checkbox"]');
        const sourceSelectorElement = this.querySelector("information-source-selector");

        if (!groundingControlsElement || !groundingSourcesElement
            || !groundedCheckbox || !includeImagesCheckbox || !sourceSelectorElement)
        {
            return;
        }

        groundedCheckbox.addEventListener("change", async () =>
        {
            const bChecked = groundedCheckbox.checked;
            groundingSourcesElement.hidden = !bChecked;
            await this.#persistPartialPreferences({ documentGroundingEnabled: bChecked });
        });

        includeImagesCheckbox.addEventListener("change", async () =>
        {
            await this.#persistPartialPreferences({ includeImagesEnabled: includeImagesCheckbox.checked });
        });

        this.#boundSourcesChangedHandler = async () =>
        {
            const liveSources = sourceSelectorElement.getSources();
            const serialisedList = liveSources.map((source) => source.toJson());
            await this.#persistPartialPreferences({ informationSources: serialisedList });
        };
        sourceSelectorElement.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, this.#boundSourcesChangedHandler);
    }

    /**
     * Hydrate the grounding UI from the deck's persisted preferences.
     * Called once on mount; subsequent toggles update both the live
     * UI and the persisted record via #persistPartialPreferences.
     */
    #hydrateGroundingFromDeck()
    {
        const preferences = this.#readAskAiPreferences();
        const groundedCheckbox = this.querySelector('[data-role="document-grounded-checkbox"]');
        const includeImagesCheckbox = this.querySelector('[data-role="include-images-checkbox"]');
        const groundingSources = this.querySelector('[data-role="grounding-sources"]');
        const sourceSelectorElement = this.querySelector("information-source-selector");

        if (groundedCheckbox)
        {
            groundedCheckbox.checked = preferences.documentGroundingEnabled;
        }
        if (includeImagesCheckbox)
        {
            includeImagesCheckbox.checked = preferences.includeImagesEnabled;
        }
        if (groundingSources)
        {
            groundingSources.hidden = !preferences.documentGroundingEnabled;
        }

        if (sourceSelectorElement && preferences.informationSources.length > 0)
        {
            // The selector finishes wiring its DOM in its own
            // connectedCallback — wait one frame so setSources finds
            // the internal list element.
            requestAnimationFrame(() =>
            {
                const rehydratedSources = preferences.informationSources
                    .map((sourceJson) => ExtractableInformationSource.fromJson(sourceJson));
                sourceSelectorElement.setSources(rehydratedSources);
            });
        }
    }

    /**
     * Show or hide the grounding controls block based on the current
     * tier. Free is a local model and doesn't ground against the
     * user's documents in this round, so the block is hidden for it.
     * Also flips the image-attach UI per the tier's
     * supportsImageInput flag (Free can't take images either).
     */
    #applyTierAwareVisibility()
    {
        const groundingControlsElement = this.querySelector('[data-role="grounding-controls"]');
        const tierSelect = this.querySelector("llm-tier-select");
        const currentTier = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;

        if (groundingControlsElement)
        {
            const bShowGrounding = TextSelectionContextMenu.#TIERS_THAT_SUPPORT_GROUNDING.has(currentTier);
            groundingControlsElement.hidden = !bShowGrounding;
        }

        if (this.#imageAttachmentManager)
        {
            const tierKeyName = TextSelectionContextMenu.#tierKeyFor(currentTier);
            const tierMeta = tierKeyName ? ModelTierMetadata[tierKeyName] : null;
            const bSupportsImageInput = Boolean(tierMeta?.supportsImageInput);
            this.#imageAttachmentManager.setVisible(bSupportsImageInput);
        }
    }

    static #tierKeyFor(tierValue)
    {
        for (const [tierKeyName, candidateValue] of Object.entries(modelTiers))
        {
            if (candidateValue === tierValue)
            {
                return tierKeyName;
            }
        }
        return null;
    }

    /**
     * Returns the current ask-AI preferences read from the deck's
     * additionalData. Missing or malformed records resolve to a
     * sensible "everything off" default so callers don't have to
     * branch on shape.
     */
    #readAskAiPreferences()
    {
        const additionalData = this.#studyDeck?.getAdditionalData?.() ?? {};
        const persisted = additionalData[TextSelectionContextMenu.#ADDITIONAL_DATA_KEY] ?? {};
        return {
            documentGroundingEnabled: persisted.documentGroundingEnabled === true,
            includeImagesEnabled:     persisted.includeImagesEnabled     === true,
            informationSources:       Array.isArray(persisted.informationSources)
                ? persisted.informationSources
                : [],
        };
    }

    /**
     * Merge the supplied fields into the persisted ask-AI prefs and
     * push the record onto the deck. Unchanged fields (notably the
     * source list when only a checkbox toggled) are preserved — so a
     * user who unchecks "Document grounded" can re-check later and
     * find their sources still in place.
     */
    async #persistPartialPreferences(partialUpdate)
    {
        if (!this.#studyDeck)
        {
            return;
        }
        const current = this.#readAskAiPreferences();
        const merged =
        {
            documentGroundingEnabled: current.documentGroundingEnabled,
            includeImagesEnabled: current.includeImagesEnabled,
            informationSources: current.informationSources,
            ...partialUpdate,
        };
        this.#studyDeck.setAdditionalDataField(TextSelectionContextMenu.#ADDITIONAL_DATA_KEY, merged);
        try
        {
            await this.#studyDeck.save();
        }
        catch (saveError)
        {
            console.warn(`[TextSelectionContextMenu] Failed to persist ask-AI prefs: ${saveError?.message || saveError}`);
        }
    }

    /**
     * Pre-flight check before firing the stub action. Returns true
     * iff the menu is in a state that can proceed; otherwise raises
     * a DialogBox.alert explaining the missing piece and returns
     * false so the caller can short-circuit. Free tier always
     * proceeds.
     */
    async #validateBeforeProceeding(tier)
    {
        if (!TextSelectionContextMenu.#TIERS_THAT_SUPPORT_GROUNDING.has(tier))
        {
            return true;
        }

        const preferences = this.#readAskAiPreferences();
        if (!preferences.documentGroundingEnabled)
        {
            return true;
        }

        if (preferences.informationSources.length === 0)
        {
            await DialogBox.alert(
                "Add an information source",
                "Use Information Sources is on but no sources are configured. Add at least one source — or turn off Use Information Sources — to proceed."
            );
            return false;
        }

        return true;
    }

    /**
     * Hand off to the AskAi streaming session — admin gate, dialog
     * open, fetch + chunked NDJSON read all happen inside
     * AskAiSession.run(). The menu's responsibility ends here.
     */
    async #dispatchAskAiSession(promptMode, userQuery, chosenTier)
    {
        const contextEntity = TextSelectionContextMenu.#currentCard
            ?? TextSelectionContextMenu.#currentStudyMaterial
            ?? null;

        if (contextEntity === null)
        {
            await DialogBox.alert(
                "No content in view",
                "Open a deck and start a study session before using the AI selection actions."
            );
            return;
        }

        // The Free tier is not wired this pass — surface the same
        // dialog the session itself would, but skip the dialog churn
        // by failing fast at the menu layer.
        if (chosenTier === modelTiers.FREE)
        {
            await DialogBox.alert(
                TextSelectionContextMenu.AI_FREE_TIER_TITLE,
                TextSelectionContextMenu.AI_FREE_TIER_MESSAGE
            );
            return;
        }

        const preferences = this.#readAskAiPreferences();
        const sourceSelectorElement = this.querySelector("information-source-selector");
        const liveSources = sourceSelectorElement?.getSources?.() ?? [];

        const askAiSession = new AskAiSession
        ({
            promptMode:             promptMode,
            chosenTier:             chosenTier,
            contextEntity:          contextEntity,
            selectedText:           this.#selectedText,
            userQuery:              userQuery,
            attachedImages:         this.#imageAttachmentManager?.getAttachedImages() ?? [],
            informationSources:     liveSources,
            useInformationSources:  preferences.documentGroundingEnabled,
        });

        await askAiSession.run();
    }
}

customElements.define(TextSelectionContextMenu.tagName, TextSelectionContextMenu);

// Module-load listener install — see the comment on #currentCard for why
// this can't live inside connectedCallback. As soon as StudyPage.js
// imports this module the listeners are armed, so CARD_CHANGED /
// STUDY_MATERIAL_CHANGED dispatches from the session reach us even
// though the menu itself hasn't mounted yet.
window.addEventListener(StudySessionEvents.CARD_CHANGED, (cardEvent) =>
{
    TextSelectionContextMenu.setCurrentCard(cardEvent.detail?.card || null);
});
window.addEventListener(StudySessionEvents.STUDY_MATERIAL_CHANGED, (materialEvent) =>
{
    TextSelectionContextMenu.setCurrentStudyMaterial(materialEvent.detail?.studyMaterial || null);
});

export default TextSelectionContextMenu;
