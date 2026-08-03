import DialogBox from "../../../CommonComponents/DialogBox.js";
import GeneratedVisualRenderer from "../../../Globals/Classes/GeneratedVisualRenderer.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import PaidDeckCopyGuard from "../../../Globals/Classes/Security/PaidDeckCopyGuard.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";
import StudyMaterialEditorPage from "../../StudyMaterialEditor/StudyMaterialEditorPage.js";
import ActiveEntityTracker from "../../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";
import ChatStudyMaterialFields from "../../../Globals/Classes/Analysis/ChatStudyMaterialFields.js";

class ContentStudySession extends StudySession
{
    #materials = [];
    #index = -1;
    #startTime = null;
    #startIndex = 0;
    #bPreview = false;

    /**
     * @param {StudyPage} studyPage
     * @param {Deck} deck
     * @param {number[] | null} selectedDetailLevels - Optional detail-level filter.
     * @param {{ bPreview?: boolean, startMaterial?: StudyMaterial } | null} previewOptions -
     *     When `bPreview` is true the session is a read-only walk-through opened from the
     *     Browser's "Preview" action: it never records a view into the lifecycle counters,
     *     and (when provided) starts at `startMaterial` rather than the first material.
     */
    constructor(studyPage, deck = null, selectedDetailLevels = null, previewOptions = null)
    {
        super(studyPage, deck);

        this.#bPreview = previewOptions?.bPreview === true;

        const allMaterials = deck.getStudyMaterials(true);

        // If the caller passed an explicit detail-level filter, honour it.
        // Otherwise study every available material (existing behaviour).
        if (Array.isArray(selectedDetailLevels) && selectedDetailLevels.length > 0)
        {
            const selectedSet = new Set(selectedDetailLevels);
            const bIncludeChat = selectedSet.has(ChatStudyMaterialFields.STUDY_PICKER_LEVEL);
            this.#materials = allMaterials.filter((material) =>
            {
                // Chat materials are their own "Chats" category — included only when
                // that category was picked, and never under a real detail level.
                if (typeof material.isChat === "function" && material.isChat())
                {
                    return bIncludeChat;
                }
                const detailLevel = material.getDetailLevel?.();
                return typeof detailLevel === "number" ? selectedSet.has(detailLevel) : true;
            });
        }
        else
        {
            this.#materials = allMaterials;
        }

        const startMaterialId = previewOptions?.startMaterial?.getId?.() ?? null;
        const foundIndex = startMaterialId !== null ? this.#materials.findIndex((material) => material.getId() === startMaterialId) : -1;
        this.#startIndex = foundIndex >= 0 ? foundIndex : 0;

        // next() advances before showing, so seed the cursor one before the
        // intended start so the first next() lands on #startIndex.
        this.#index = this.#startIndex - 1;
        this._current = null;
        this.#startTime = new Date();

        if(this.#materials.length === 0)
        {
            PageNavigator.back();
            DialogBox.alert("Note", "No study material available in this deck.");
        }
    }

    #handleEvents()
    {
        const nextButton = this._studyPage.querySelector(".next-card-button");
        const previousButton = this._studyPage.querySelector(".previous-card-button");
        const progressionContainer = this._studyPage.querySelector(".card-progression-container");

        progressionContainer.innerHTML = `${this.#startIndex + 1}/${this.#materials.length}`;

        nextButton.addEventListener("click", async () =>
        {
            // next() can await an "end reached" dialog before it wraps, so
            // the progress count must be refreshed AFTER it resolves —
            // otherwise it would read the pre-navigation index.
            await this.next();
            progressionContainer.innerHTML = `${this.#index + 1}/${this.#materials.length}`;
        });

        previousButton.addEventListener("click", () =>
        {
            this.previous();
            progressionContainer.innerHTML = `${this.#index + 1}/${this.#materials.length}`;
        });
    }

    start()
    {
        this.#handleEvents();

        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");

        if(previousNextButtonContainer)
        {
            previousNextButtonContainer.style.display = "flex";
        }

        // Mount the edit button inside the .study-action-row, immediately
        // before the assistant-toggle-button, so it shares the same flex row
        // as Previous/Next, the zoom controls and the assistant toggle.
        // Putting it between the content section and the action row would
        // burn a whole vertical line of its own — wasteful given how tight
        // the study page is for vertical space in landscape.
        const actionRow = this._studyPage.querySelector(".study-action-row");
        const assistantToggleButton = actionRow?.querySelector(".assistant-toggle-button");

        if(actionRow)
        {
            const editButton = document.createElement("button");
            editButton.textContent = "Edit";
            editButton.className = "edit-study-material-button";
            editButton.addEventListener("click", () =>
            {
                PageNavigator.open("study-material-editor-page", this._current, this._deck);
            });

            if(assistantToggleButton)
            {
                actionRow.insertBefore(editButton, assistantToggleButton);
            }
            else
            {
                actionRow.appendChild(editButton);
            }
        }

        this.next();
    }

    async next()
    {
        // When the learner is on the last material and presses Next, tell
        // them they've reached the end before looping back to the first —
        // rather than silently wrapping as if nothing happened. Guarded on
        // length > 1 so a single-material deck doesn't nag on every press.
        if(this.#materials.length > 1 && this.#index === this.#materials.length - 1)
        {
            await DialogBox.alert("End reached", "You've reached the last study material — starting again from the beginning.");
        }

        this.#index = (this.#index + 1) % this.#materials.length;

        this._current = this.#materials[this.#index];
        this.#startTime = new Date();

        this.#showMaterial(this._current);
    }

    previous()
    {
        this.#index = (this.#index - 1 + this.#materials.length) % this.#materials.length;

        this._current = this.#materials[this.#index];
        this.#startTime = new Date();

        this.#showMaterial(this._current);
    }

    async #showMaterial(material)
    {
        const container = this._studyPage.querySelector(".study-material-content-section");

        if(!container)
        {
            return;
        }

        ActiveEntityTracker.set(material.getId(), entityTypes.STUDY_MATERIAL);

        container.innerHTML = HtmlSanitizer.sanitize(material.getContent());
        this._studyPage.renderLatex();
        GeneratedVisualRenderer.render(container);

        // Block copy / cut / right-click over a purchased material's content.
        // Selection stays available so Ask-AI-on-selection still works.
        const paidDeckId = material.getDeck?.()?.getAdditionalData?.()?.paidDeckId;
        if (paidDeckId)
        {
            PaidDeckCopyGuard.registerContainer(container, paidDeckId, material.getId());
        }

        // Each material is a fresh document, so start it at the top rather
        // than inheriting the previous material's scroll offset. The
        // .study-page-container is the scrolling ancestor (the content
        // section itself has no overflow); reset the content section too so
        // a future layout that makes it the scroller stays correct.
        const scrollContainer = this._studyPage.querySelector(".study-page-container");
        if(scrollContainer)
        {
            scrollContainer.scrollTop = 0;
        }
        container.scrollTop = 0;

        // Notify the bottom panel (and any other listener) that the
        // visible study material just changed.
        window.dispatchEvent(new CustomEvent(StudySessionEvents.STUDY_MATERIAL_CHANGED, {detail: {studyMaterial: material}}));

        // Preview is a read-only walk-through — never bump the view / time
        // counters or persist anything for the material being previewed.
        if(!this.#bPreview)
        {
            await material.view(this.getTimeSpent(), true);
        }
    }

    onResumed()
    {
        if (this._current)
        {
            this.#showMaterial(this._current);
        }
    }

    getTimeSpent()
    {
        return (Date.now() - this.#startTime) / 1000;
    }
}

export default ContentStudySession;