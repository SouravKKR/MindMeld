import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";
import StudyMaterialEditorPage from "../../StudyMaterialEditor/StudyMaterialEditorPage.js";
import ActiveEntityTracker from "../../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";

class ContentStudySession extends StudySession
{
    #materials = [];
    #index = -1;
    #startTime = null;

    constructor(studyPage, deck = null, selectedDetailLevels = null)
    {
        super(studyPage, deck);

        const allMaterials = deck.getStudyMaterials(true);

        // If the caller passed an explicit detail-level filter, honour it.
        // Otherwise study every available material (existing behaviour).
        if (Array.isArray(selectedDetailLevels) && selectedDetailLevels.length > 0)
        {
            const selectedSet = new Set(selectedDetailLevels);
            this.#materials = allMaterials.filter((material) =>
            {
                const detailLevel = material.getDetailLevel?.();
                return typeof detailLevel === "number" ? selectedSet.has(detailLevel) : true;
            });
        }
        else
        {
            this.#materials = allMaterials;
        }

        this.#index = -1;
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

        progressionContainer.innerHTML = `1/${this.#materials.length}`;

        nextButton.addEventListener("click", () =>
        {
            this.next();
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

    next()
    {
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

        container.innerHTML = material.getContent();
        this._studyPage.renderLatex();

        // Notify the bottom panel (and any other listener) that the
        // visible study material just changed.
        window.dispatchEvent(new CustomEvent(StudySessionEvents.STUDY_MATERIAL_CHANGED, {detail: {studyMaterial: material}}));

        await material.view(this.getTimeSpent(), true);
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