import StudyMaterialGenerationSettings from "../../../Globals/Classes/Task/AutoGeneration/StudyMaterialGenerationSettings.js";
import { studyMaterialDetailLevels } from "../../../Globals/Enumerations/StudyMaterialDetailLevels.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import GenerationFields from "./GenerationFields.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";

class StudyMaterialGenerationFields extends GenerationFields
{
    static settingsClass = StudyMaterialGenerationSettings;
    static settingsKey = "studyMaterialGeneration";
    static taskType = taskTypes.GENERATE_STUDY_MATERIAL;
    static tagName = "study-material-generation-fields";

    // Plain-English descriptions appended in parens after each detail-level
    // checkbox label so the user knows what each tier produces.
    static #DETAIL_LEVEL_DESCRIPTIONS =
    {
        SUMMARY:       "Crisp bullets/tables for quick revision",
        STANDARD:      "Balanced study notes suitable for everyone",
        COMPREHENSIVE: "In-depth coverage with background and derivations"
    };

    validate()
    {
        const settings = this.getSettings();

        if (settings instanceof StudyMaterialGenerationSettings)
        {
            if (settings.getDetailLevels().length === 0)
            {
                return false;
            }
        }

        return true;
    }

    static #buildDetailLevelCardHtml(keyValue, titleText, descriptionText)
    {
        const descriptionMarkup = descriptionText
            ? `<span class="detail-level-card-description">${descriptionText}</span>`
            : "";

        return `
            <div class="detail-level-card" data-detail-level="${keyValue}">
                <input type="checkbox" id="detail-level-${keyValue}">
                <label for="detail-level-${keyValue}">
                    <span class="detail-level-card-title">${titleText}</span>
                    ${descriptionMarkup}
                </label>
            </div>
        `;
    }

    #populateDetailLevelCards()
    {
        const container = this.querySelector(".detail-levels-list");

        for (const key of Object.keys(studyMaterialDetailLevels))
        {
            const titleCaseLabel = enumerationToTitleCase(key);
            const description    = StudyMaterialGenerationFields.#DETAIL_LEVEL_DESCRIPTIONS[key];
            container.innerHTML += StudyMaterialGenerationFields.#buildDetailLevelCardHtml(key, titleCaseLabel, description);
        }
    }

    /**
     * Public hook used by AutomaticGenerationPage after a template applies.
     * Re-pulls every bound field from the settings instance.
     */
    rebuildFromSettings()
    {
        this.#initializeFromSettings();
    }

    #setupUi()
    {
        this.#populateDetailLevelCards();
        this.#initializeFromSettings();
        this.#bindSettings();
    }

    #initializeFromSettings()
    {
        const settings = this.getSettings();
        const selectedLevels = settings.getDetailLevels();

        for (const card of this.querySelectorAll(".detail-levels-list .detail-level-card"))
        {
            const levelKey = card.dataset.detailLevel;
            const levelValue = studyMaterialDetailLevels[levelKey];
            card.querySelector("input[type='checkbox']").checked = selectedLevels.includes(levelValue);
        }

        this.querySelector(".study-material-generation-additional-instructions-input").value = settings.getAdditionalInstructions();
    }

    #syncDetailLevels()
    {
        const selectedLevels = [];

        for (const card of this.querySelectorAll(".detail-levels-list .detail-level-card"))
        {
            const levelKey = card.dataset.detailLevel;
            const isChecked = card.querySelector("input[type='checkbox']").checked;

            if (isChecked)
            {
                selectedLevels.push(studyMaterialDetailLevels[levelKey]);
            }
        }

        this.getSettings().setDetailLevels(selectedLevels);
    }

    #bindSettings()
    {
        const additionalInstructionsInput = this.querySelector(".study-material-generation-additional-instructions-input");

        for (const card of this.querySelectorAll(".detail-levels-list .detail-level-card"))
        {
            card.querySelector("input[type='checkbox']").addEventListener("change", () =>
            {
                this.#syncDetailLevels();
            });
        }

        additionalInstructionsInput.addEventListener("input", () =>
        {
            this.getSettings().setAdditionalInstructions(additionalInstructionsInput.value);
        });

        this.#syncDetailLevels();
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <h2>Customize Study Material Generation</h2>

            <div class="detail-levels-container field-container">
                <label>Detail Levels to Generate: </label>
                <div class="detail-levels-list"></div>
            </div>

            <div class="additional-instructions-container field-container">
                <label>Additional Instructions (Optional): </label>
                <input type="text" placeholder="Enter Additional Instructions..." class="study-material-generation-additional-instructions-input">
            </div>
        `;

        this.dataset.rebuildFromSettings = "true";

        this.#setupUi();
    }
}

customElements.define("study-material-generation-fields", StudyMaterialGenerationFields);
export default StudyMaterialGenerationFields;