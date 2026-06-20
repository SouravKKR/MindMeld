import DialogBox from "../../../CommonComponents/DialogBox.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";
import LlmTierSelect from "../../../CommonComponents/LlmTierSelect.js";
import LanguageSelect from "../../../CommonComponents/LanguageSelect.js";
import { modelTiers } from "../../../Globals/Enumerations/ModelTiers.js";
import { askAiPromptModes } from "../../../Globals/Enumerations/AskAiPromptModes.js";
import ModelTierMetadata from "../../../Globals/Constants/ModelTierMetadata.js";
import BrowserLlmDownloadConstants from "../../../Globals/Constants/BrowserLlmDownloadConstants.js";
import InformationSourceSelector from "../../AutomaticGeneration/Components/InformationSourceSelector.js";
import ExtractableInformationSource from "../../../Globals/Classes/Decorators/ExtractableInformationSource.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import Deck from "../../../Globals/Model/Deck.js";
import AskAiSession from "../Classes/AskAiSession.js";
import AskAiImageAttachmentManager from "../Classes/AskAiImageAttachmentManager.js";
import EnhanceFlow from "../Classes/EnhanceFlow.js";

/**
 * StudySessionBottomPanel
 *
 * Drawer-style assistant panel mounted at the bottom of the Study page
 * for spaced-repetition / revise / content-study sessions. It is NOT
 * mounted for mock-test sessions — that layout intentionally has a
 * different chrome.
 *
 * The panel exposes:
 *   - LlmTierSelect to pick the cloud model tier.
 *   - "Use Information Sources" grounding controls (mirrors the
 *     TextSelectionContextMenu's controls; persistence key is shared so
 *     the two surfaces show the same on/off + source list per deck).
 *   - A multi-line "Ask" contenteditable + Send button, with a "+"
 *     image-attach affordance and paste-image interception (delegated
 *     to AskAiImageAttachmentManager).
 *   - Explain / Summarize / Enhance action buttons.
 *   - (Card mode only) a Mark-for-Review toggle that persists immediately.
 *
 * Explain / Summarize / Ask all run through AskAiSession with no
 * `selectedText` — the prompt builder reads "no selection" as "act on
 * the whole entity" and picks the WHOLE-variant template
 * (ASK_AI_*_WHOLE_USER.txt / ASK_AI_SUMMARIZE_*_USER.txt).
 *
 * Enhance opens a sub-tool picker (Make mnemonic / Format) and routes
 * each tool through AskAiSession with its own prompt mode. The result
 * streams into the same dialog as Explain / Summarize / Ask. The
 * "insert back into the card / study material" step has its own slot
 * in the result view's actions bar — wiring that lands in a later pass.
 *
 * The panel tracks the currently-displayed Card / StudyMaterial via
 * the StudySessionEvents.CARD_CHANGED / STUDY_MATERIAL_CHANGED events
 * the active session dispatches — no direct session reference needed.
 */
class StudySessionBottomPanel extends HTMLElement
{
    static MODE_CARD            = "card";
    static MODE_STUDY_MATERIAL  = "study-material";

    static AI_FREE_TIER_TITLE   = "Free tier unavailable";
    static AI_FREE_TIER_MESSAGE = "The Free tier is offline-only and not wired for streaming yet. Pick Basic, Pro, or Pro Plus.";

    // Tiers that support the cloud Ask-AI flow (Free is in-browser only).
    // Mirrors TextSelectionContextMenu so the grounding/image-attach UI
    // shows under the same conditions on both surfaces.
    static #TIERS_THAT_SUPPORT_GROUNDING = new Set([
        modelTiers.BASIC,
        modelTiers.PRO,
        modelTiers.PRO_PLUS,
    ]);

    // Shared persistence key with the TextSelectionContextMenu. A single
    // toggle per deck drives both surfaces' grounding state — the user
    // configures sources once and they apply wherever the AskAi flow
    // runs.
    static #ADDITIONAL_DATA_KEY = BrowserLlmDownloadConstants.DECK_PREFERENCES_FIELD_KEY;

    #mode             = StudySessionBottomPanel.MODE_CARD;
    #currentCard      = null;
    #currentStudyMaterial = null;
    #studyDeck        = null;
    #cardChangedHandler          = null;
    #studyMaterialChangedHandler = null;
    #boundTierSelectedHandler    = null;
    #boundSourcesChangedHandler  = null;
    #imageAttachmentManager      = null;

    static create(mode, initialEntity = null)
    {
        const panel = document.createElement("study-session-bottom-panel");
        panel.initialize(mode, initialEntity);
        return panel;
    }

    initialize(mode, initialEntity = null)
    {
        this.#mode = mode === StudySessionBottomPanel.MODE_STUDY_MATERIAL
            ? StudySessionBottomPanel.MODE_STUDY_MATERIAL
            : StudySessionBottomPanel.MODE_CARD;

        if (this.#mode === StudySessionBottomPanel.MODE_CARD)
        {
            this.#currentCard = initialEntity;
        }
        else
        {
            this.#currentStudyMaterial = initialEntity;
        }
    }

    connectedCallback()
    {
        this.dataset.mode = this.#mode;
        this.#studyDeck   = Deck.getCurrentDeck();

        this.innerHTML =
        `
            <div class="bottom-panel-body">
                <div class="bottom-panel-tier-row">
                    <llm-tier-select></llm-tier-select>
                </div>
                <div class="bottom-panel-language-row">
                    <language-select></language-select>
                </div>
                <div class="bottom-panel-grounding-controls" data-role="grounding-controls" hidden>
                    <label class="bottom-panel-grounding-checkbox-row">
                        <input type="checkbox" data-role="document-grounded-checkbox">
                        <span class="bottom-panel-grounding-label">Use Information Sources</span>
                        <span class="bottom-panel-grounding-hint">slight extra cost</span>
                    </label>
                    <div class="bottom-panel-grounding-sources" data-role="grounding-sources" hidden>
                        <information-source-selector exclude-types="CURRICULUM_OR_SYLLABUS"></information-source-selector>
                        <label class="bottom-panel-grounding-checkbox-row">
                            <input type="checkbox" data-role="include-images-checkbox">
                            <span class="bottom-panel-grounding-label">Include images from sources</span>
                        </label>
                    </div>
                </div>
                <div class="bottom-panel-question-row">
                    <div
                        class="bottom-panel-question-input"
                        contenteditable="true"
                        role="textbox"
                        aria-multiline="true"
                        data-placeholder="Ask a specific question..."
                    ></div>
                    <button class="bottom-panel-send-button" type="button" aria-label="Send question">Send</button>
                </div>
                <div class="bottom-panel-action-row">
                    <button class="bottom-panel-explain-button" type="button">Explain</button>
                    <button class="bottom-panel-summarize-button" type="button">Summarize</button>
                    <button class="bottom-panel-enhance-button" type="button">Enhance</button>
                    <button class="bottom-panel-mark-review-toggle" type="button">Mark for Review</button>
                </div>
            </div>
        `;

        this.#bindButtons();
        this.#bindSessionEventListeners();
        this.#bindGroundingEvents();
        this.#hydrateGroundingFromDeck();
        // The <language-select> owns its own global persistence
        // (PreferredAskAiLanguage) and cross-instance sync, so this host
        // no longer hydrates or persists the language onto the deck.
        this.#mountImageAttachmentManager();
        this.#applyTierAwareVisibility();
        this.#refreshMarkReviewToggleLabel();
    }

    disconnectedCallback()
    {
        if (this.#cardChangedHandler)
        {
            window.removeEventListener(StudySessionEvents.CARD_CHANGED, this.#cardChangedHandler);
            this.#cardChangedHandler = null;
        }
        if (this.#studyMaterialChangedHandler)
        {
            window.removeEventListener(StudySessionEvents.STUDY_MATERIAL_CHANGED, this.#studyMaterialChangedHandler);
            this.#studyMaterialChangedHandler = null;
        }
        if (this.#boundTierSelectedHandler)
        {
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

    #bindButtons()
    {
        const sendButton          = this.querySelector(".bottom-panel-send-button");
        const explainButton       = this.querySelector(".bottom-panel-explain-button");
        const summarizeButton     = this.querySelector(".bottom-panel-summarize-button");
        const enhanceButton       = this.querySelector(".bottom-panel-enhance-button");
        const markReviewToggle    = this.querySelector(".bottom-panel-mark-review-toggle");

        sendButton.addEventListener("click", async () =>
        {
            await this.#handleSendQuestion();
        });

        explainButton.addEventListener("click", async () =>
        {
            await this.#dispatchWholeEntitySession(askAiPromptModes.EXPLAIN, null);
        });

        summarizeButton.addEventListener("click", async () =>
        {
            await this.#dispatchWholeEntitySession(askAiPromptModes.SUMMARIZE, null);
        });

        enhanceButton.addEventListener("click", async () =>
        {
            await this.#openEnhanceDialog();
        });

        markReviewToggle.addEventListener("click", async () =>
        {
            await this.#toggleMarkForReview();
        });

        // The Ask contenteditable needs a tier-change listener so the
        // grounding-controls and image-attach UI re-evaluate visibility
        // when the user picks a new tier from the dropdown.
        const tierSelect = this.querySelector("llm-tier-select");
        this.#boundTierSelectedHandler = () =>
        {
            this.#applyTierAwareVisibility();
        };
        tierSelect?.addEventListener("tier-selected", this.#boundTierSelectedHandler);
    }

    #bindSessionEventListeners()
    {
        this.#cardChangedHandler = (event) =>
        {
            if (this.#mode !== StudySessionBottomPanel.MODE_CARD)
            {
                return;
            }
            this.#currentCard = event.detail?.card || null;
            this.#refreshMarkReviewToggleLabel();
        };

        this.#studyMaterialChangedHandler = (event) =>
        {
            if (this.#mode !== StudySessionBottomPanel.MODE_STUDY_MATERIAL)
            {
                return;
            }
            this.#currentStudyMaterial = event.detail?.studyMaterial || null;
        };

        window.addEventListener(StudySessionEvents.CARD_CHANGED, this.#cardChangedHandler);
        window.addEventListener(StudySessionEvents.STUDY_MATERIAL_CHANGED, this.#studyMaterialChangedHandler);
    }

    /**
     * Wire the document-grounding + include-images checkboxes + the
     * inline information-source-selector. Each user change persists to
     * the deck's additionalData under the SAME key the
     * TextSelectionContextMenu uses, so toggling on one surface is
     * reflected on the other.
     */
    #bindGroundingEvents()
    {
        const groundingSourcesElement = this.querySelector('[data-role="grounding-sources"]');
        const groundedCheckbox        = this.querySelector('[data-role="document-grounded-checkbox"]');
        const includeImagesCheckbox   = this.querySelector('[data-role="include-images-checkbox"]');
        const sourceSelectorElement   = this.querySelector("information-source-selector");

        if (!groundingSourcesElement || !groundedCheckbox || !includeImagesCheckbox || !sourceSelectorElement)
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
            const liveSources    = sourceSelectorElement.getSources();
            const serialisedList = liveSources.map((source) => source.toJson());
            await this.#persistPartialPreferences({ informationSources: serialisedList });
        };
        sourceSelectorElement.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, this.#boundSourcesChangedHandler);
    }

    /**
     * Hydrate the grounding UI from the deck's persisted preferences.
     */
    #hydrateGroundingFromDeck()
    {
        const preferences           = this.#readAskAiPreferences();
        const groundedCheckbox      = this.querySelector('[data-role="document-grounded-checkbox"]');
        const includeImagesCheckbox = this.querySelector('[data-role="include-images-checkbox"]');
        const groundingSources      = this.querySelector('[data-role="grounding-sources"]');
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
     * Mount the image-attach manager into the Ask row. Hidden for tiers
     * that don't support image input (Free).
     */
    #mountImageAttachmentManager()
    {
        const questionRow          = this.querySelector(".bottom-panel-question-row");
        const questionInputElement = this.querySelector(".bottom-panel-question-input");
        if (!questionRow || !questionInputElement)
        {
            return;
        }
        this.#imageAttachmentManager = new AskAiImageAttachmentManager(questionRow, questionInputElement);
        this.#imageAttachmentManager.mount();
    }

    /**
     * Show / hide grounding controls + image-attach surface based on
     * the current tier. Free is local-only and doesn't ground or take
     * image input in this round.
     */
    #applyTierAwareVisibility()
    {
        const groundingControlsElement = this.querySelector('[data-role="grounding-controls"]');
        const tierSelect               = this.querySelector("llm-tier-select");
        const currentTier              = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;

        if (groundingControlsElement)
        {
            const bShowGrounding = StudySessionBottomPanel.#TIERS_THAT_SUPPORT_GROUNDING.has(currentTier);
            groundingControlsElement.hidden = !bShowGrounding;
        }

        if (this.#imageAttachmentManager)
        {
            const tierKeyName        = StudySessionBottomPanel.#tierKeyFor(currentTier);
            const tierMeta           = tierKeyName ? ModelTierMetadata[tierKeyName] : null;
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

    async #handleSendQuestion()
    {
        const questionInput = this.querySelector(".bottom-panel-question-input");
        const trimmedText   = (questionInput?.textContent || "").trim();

        if (trimmedText.length === 0)
        {
            await DialogBox.alert("Ask a question", "Type your question first, then press Send.");
            questionInput?.focus();
            return;
        }

        await this.#dispatchWholeEntitySession(askAiPromptModes.ASK, trimmedText);
    }

    /**
     * Hand off to AskAiSession with no selectedText — the prompt
     * builder treats empty selection as "act on the whole entity" and
     * picks the WHOLE-variant template (or the SUMMARIZE template
     * directly). All four bottom-panel actions (Explain, Summarize,
     * Ask Send) route through here.
     */
    async #dispatchWholeEntitySession(promptMode, userQuery)
    {
        const tierSelect    = this.querySelector("llm-tier-select");
        const chosenTier    = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;

        if (chosenTier === modelTiers.FREE)
        {
            await DialogBox.alert(
                StudySessionBottomPanel.AI_FREE_TIER_TITLE,
                StudySessionBottomPanel.AI_FREE_TIER_MESSAGE
            );
            return;
        }

        if (!await this.#validateGroundingBeforeProceeding(chosenTier))
        {
            return;
        }

        const contextEntity = this.#mode === StudySessionBottomPanel.MODE_CARD
            ? this.#currentCard
            : this.#currentStudyMaterial;

        if (!contextEntity)
        {
            await DialogBox.alert(
                "No content in view",
                "Open a deck and start a study session before using the assistant."
            );
            return;
        }

        const preferences             = this.#readAskAiPreferences();
        const sourceSelectorElement   = this.querySelector("information-source-selector");
        const liveSources             = sourceSelectorElement?.getSources?.() ?? [];
        const languageSelect          = this.querySelector("language-select");

        const askAiSession = new AskAiSession
        ({
            promptMode:            promptMode,
            chosenTier:            chosenTier,
            contextEntity:         contextEntity,
            selectedText:          "",
            userQuery:             userQuery,
            attachedImages:        this.#imageAttachmentManager?.getAttachedImages() ?? [],
            informationSources:    liveSources,
            useInformationSources: preferences.documentGroundingEnabled,
            selectedLanguage:      languageSelect?.getSelectedLanguageKey() ?? "ENGLISH",
            combineWithEnglish:    languageSelect?.getCombineWithEnglish() ?? false,
        });

        await askAiSession.run();
    }

    /**
     * Pre-flight check before firing AskAiSession. Mirrors the
     * TextSelectionContextMenu's #validateBeforeProceeding logic so the
     * user gets the same "Add a source" prompt on either surface.
     */
    async #validateGroundingBeforeProceeding(tier)
    {
        if (!StudySessionBottomPanel.#TIERS_THAT_SUPPORT_GROUNDING.has(tier))
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

    #readAskAiPreferences()
    {
        const additionalData = this.#studyDeck?.getAdditionalData?.() ?? {};
        const persisted      = additionalData[StudySessionBottomPanel.#ADDITIONAL_DATA_KEY] ?? {};
        return {
            documentGroundingEnabled: persisted.documentGroundingEnabled === true,
            includeImagesEnabled:     persisted.includeImagesEnabled     === true,
            informationSources:       Array.isArray(persisted.informationSources)
                ? persisted.informationSources
                : [],
        };
    }

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
            includeImagesEnabled:     current.includeImagesEnabled,
            informationSources:       current.informationSources,
            ...partialUpdate,
        };
        this.#studyDeck.setAdditionalDataField(StudySessionBottomPanel.#ADDITIONAL_DATA_KEY, merged);
        try
        {
            await this.#studyDeck.save();
        }
        catch (saveError)
        {
            console.warn(`[StudySessionBottomPanel] Failed to persist ask-AI prefs: ${saveError?.message || saveError}`);
        }
    }

    async #openEnhanceDialog()
    {
        // The picker UI is shared with TextSelectionContextMenu's Enhance
        // button via EnhanceFlow. The bottom panel always acts on the
        // whole entity, so no selectedText is forwarded — the prompt
        // builder treats the empty selection as "act on the whole entity"
        // and picks the *_WHOLE_USER template.
        const choice = await EnhanceFlow.open({});
        if (!choice)
        {
            return;
        }
        await this.#dispatchWholeEntitySession(
            choice.promptModeValue,
            choice.instructions.length > 0 ? choice.instructions : null
        );
    }

    async #toggleMarkForReview()
    {
        if (this.#mode !== StudySessionBottomPanel.MODE_CARD)
        {
            return;
        }
        if (!this.#currentCard)
        {
            return;
        }

        const wasMarked = this.#currentCard.isReview?.() === true;
        this.#currentCard.setAdditionalDataField("review", !wasMarked);

        try
        {
            await this.#currentCard.save(false);
        }
        catch (saveError)
        {
            console.warn("[StudySessionBottomPanel] Failed to persist mark-for-review toggle:", saveError);
        }

        this.#refreshMarkReviewToggleLabel();
    }

    #refreshMarkReviewToggleLabel()
    {
        const markReviewToggle = this.querySelector(".bottom-panel-mark-review-toggle");
        if (!markReviewToggle)
        {
            return;
        }

        if (this.#mode !== StudySessionBottomPanel.MODE_CARD)
        {
            markReviewToggle.style.display = "none";
            return;
        }

        const isMarked = this.#currentCard?.isReview?.() === true;
        markReviewToggle.textContent = isMarked ? "Remove from Review" : "Mark for Review";
        markReviewToggle.classList.toggle("bottom-panel-mark-review-toggle--active", isMarked);
    }
}

customElements.define("study-session-bottom-panel", StudySessionBottomPanel);
export default StudySessionBottomPanel;
