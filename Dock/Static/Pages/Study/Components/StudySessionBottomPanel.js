import DialogBox from "../../../CommonComponents/DialogBox.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";
import LlmTierSelect from "../../../CommonComponents/LlmTierSelect.js";
import { modelTiers } from "../../../Globals/Enumerations/ModelTiers.js";
import ModelTierMetadata from "../../../Globals/Constants/ModelTierMetadata.js";

/**
 * StudySessionBottomPanel
 *
 * Drawer-style assistant panel mounted at the bottom of the Study page
 * for spaced-repetition / revise / content-study sessions. It is NOT
 * mounted for mock-test sessions — that layout intentionally has a
 * different chrome.
 *
 * The panel exposes:
 *   - A multi-line "Ask" contenteditable + Send button.
 *   - Explain / Summarize / Enhance action buttons.
 *   - (Card mode only) a Mark-for-Review toggle that persists immediately.
 *   - A collapse toggle that slides the body down with a CSS animation,
 *     leaving only the drag-bar visible so the user can re-open it.
 *
 * AI actions are placeholder-stubbed via DialogBox.alert until the
 * backend hookup pass.
 *
 * The panel tracks the currently-displayed Card / StudyMaterial via
 * the StudySessionEvents.CARD_CHANGED / STUDY_MATERIAL_CHANGED events
 * the active session dispatches — no direct session reference needed.
 */
class StudySessionBottomPanel extends HTMLElement
{
    static MODE_CARD            = "card";
    static MODE_STUDY_MATERIAL  = "study-material";

    static AI_PLACEHOLDER_TITLE   = "AI feature placeholder";
    static AI_PLACEHOLDER_MESSAGE = "This action will be wired up in a later pass — backend not connected yet.";

    static ENHANCEMENT_TOOLS =
    [
        { key: "make-mnemonic", label: "Make mnemonic" },
        { key: "format",        label: "Format" }
    ];

    #mode             = StudySessionBottomPanel.MODE_CARD;
    #currentCard      = null;
    #currentStudyMaterial = null;
    #cardChangedHandler          = null;
    #studyMaterialChangedHandler = null;

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

        this.innerHTML =
        `
            <div class="bottom-panel-body">
                <div class="bottom-panel-tier-row">
                    <llm-tier-select></llm-tier-select>
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
            await this.#showPlaceholderAlert("Explain");
        });

        summarizeButton.addEventListener("click", async () =>
        {
            await this.#showPlaceholderAlert("Summarize");
        });

        enhanceButton.addEventListener("click", async () =>
        {
            await this.#openEnhanceDialog();
        });

        markReviewToggle.addEventListener("click", async () =>
        {
            await this.#toggleMarkForReview();
        });
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

    async #handleSendQuestion()
    {
        const questionInput = this.querySelector(".bottom-panel-question-input");
        const rawHtml       = questionInput?.innerHTML || "";
        const trimmedText   = (questionInput?.textContent || "").trim();

        if (trimmedText.length === 0)
        {
            await DialogBox.alert("Ask a question", "Type your question first, then press Send.");
            return;
        }

        await this.#showPlaceholderAlertWithBody(
            "Ask",
            `Your question:<div class="bottom-panel-placeholder-echo">${rawHtml}</div>`
        );
    }

    async #showPlaceholderAlert(actionLabel)
    {
        const tierLabel = this.#readCurrentTierLabel();
        await DialogBox.alert(
            StudySessionBottomPanel.AI_PLACEHOLDER_TITLE,
            `${actionLabel} (${tierLabel}) — ${StudySessionBottomPanel.AI_PLACEHOLDER_MESSAGE}`
        );
    }

    async #showPlaceholderAlertWithBody(actionLabel, htmlBody)
    {
        // Reuses DialogBox.alert; the message is plain text but
        // DialogBox.alert sets it via textContent, so any HTML is
        // shown verbatim. That's intentional for a placeholder — the
        // user sees exactly what would have gone to the backend.
        const tierLabel = this.#readCurrentTierLabel();
        await DialogBox.alert(
            StudySessionBottomPanel.AI_PLACEHOLDER_TITLE,
            `${actionLabel} (${tierLabel}). ${StudySessionBottomPanel.AI_PLACEHOLDER_MESSAGE}\n\n` +
            this.#stripHtmlForPlaintext(htmlBody)
        );
    }

    /**
     * Reads the currently-selected tier from the select mounted at
     * the top of the panel. Falls back to the BASIC tier label when
     * the select isn't yet mounted (defensive — shouldn't happen
     * once connectedCallback has run).
     */
    #readCurrentTierLabel()
    {
        const tierSelect = this.querySelector("llm-tier-select");
        const chosenTier = tierSelect?.getCurrentTier() ?? modelTiers.BASIC;
        for (const [tierKeyName, candidateValue] of Object.entries(modelTiers))
        {
            if (candidateValue === chosenTier)
            {
                const meta = ModelTierMetadata[tierKeyName];
                return meta?.label || tierKeyName;
            }
        }
        return "Basic";
    }

    #stripHtmlForPlaintext(htmlString)
    {
        const sandbox = document.createElement("div");
        sandbox.innerHTML = htmlString;
        return (sandbox.textContent || "").trim();
    }

    async #openEnhanceDialog()
    {
        return new Promise((resolve) =>
        {
            const toolOptionsMarkup = StudySessionBottomPanel.ENHANCEMENT_TOOLS
                .map((tool, toolIndex) => `
                    <label class="bottom-panel-enhance-option">
                        <input
                            type="radio"
                            name="bottom-panel-enhance-tool"
                            value="${tool.key}"
                            ${toolIndex === 0 ? "checked" : ""}
                        >
                        <span>${tool.label}</span>
                    </label>
                `).join("");

            const dialog = DialogBox.modal
            (`
                <div class="bottom-panel-enhance-dialog">
                    <h2>Enhance</h2>
                    <p>Pick an enhancement to apply, optionally with additional instructions.</p>
                    <div class="bottom-panel-enhance-options">${toolOptionsMarkup}</div>
                    <label class="bottom-panel-enhance-instructions-label">
                        Additional instructions (optional)
                        <textarea
                            class="bottom-panel-enhance-instructions"
                            rows="3"
                            placeholder="e.g. focus on the second derivative"
                        ></textarea>
                    </label>
                    <div class="bottom-panel-enhance-actions">
                        <button type="button" class="bottom-panel-enhance-cancel">Cancel</button>
                        <button type="button" class="bottom-panel-enhance-apply">Apply</button>
                    </div>
                </div>
            `);

            const finalize = (chosenTool, additionalInstructions) =>
            {
                dialog.close();
                resolve();

                if (chosenTool === null)
                {
                    return;
                }

                this.#showPlaceholderAlertWithBody(
                    `Enhance · ${chosenTool.label}`,
                    additionalInstructions.length > 0
                        ? `Instructions: ${additionalInstructions}`
                        : "(no additional instructions)"
                );
            };

            dialog.querySelector(".bottom-panel-enhance-cancel").addEventListener("click", () =>
            {
                finalize(null, "");
            });

            dialog.querySelector(".bottom-panel-enhance-apply").addEventListener("click", () =>
            {
                const selectedRadio = dialog.querySelector("input[name=\"bottom-panel-enhance-tool\"]:checked");
                const selectedKey   = selectedRadio?.value || StudySessionBottomPanel.ENHANCEMENT_TOOLS[0].key;
                const selectedTool  = StudySessionBottomPanel.ENHANCEMENT_TOOLS.find(tool => tool.key === selectedKey)
                    || StudySessionBottomPanel.ENHANCEMENT_TOOLS[0];
                const instructions  = (dialog.querySelector(".bottom-panel-enhance-instructions")?.value || "").trim();
                finalize(selectedTool, instructions);
            });
        });
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
