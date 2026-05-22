import FlashcardGenerationSettings from "../../../Globals/Classes/Task/AutoGeneration/FlashcardGenerationSettings.js";
import { automationLevels } from "../../../Globals/Enumerations/AutomationLevels.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { difficultyLevels } from "../../../Globals/Enumerations/DifficultyLevels.js";
import { convertElementToEnumSelect } from "../../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import GenerationFields from "./GenerationFields.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";

class FlashcardGenerationFields extends GenerationFields
{
    static settingsClass = FlashcardGenerationSettings;
    static settingsKey = "flashcardGeneration";
    static taskType = taskTypes.GENERATE_FLASHCARDS;
    static tagName = "flashcard-generation-fields";

    // Each entry is a closure that re-applies visibility for one
    // (method-select, dependent-container) pair. Populated by
    // #handleSelectionMethodVisibility and re-invoked from
    // refreshFromSettings — programmatic select.value writes don't fire
    // the change event, so we have to re-evaluate visibility manually.
    #visibilityRefreshers = [];

    validate()
    {
        const settings = this.getSettings();

        if (settings instanceof FlashcardGenerationSettings)
        {
            if (settings.getNumCardsMethod() == automationLevels.MANUAL)
            {
                if (settings.getNumQuestionsToGenerate() <= 5 || settings.getNumQuestionsToGenerate() > 500)
                {
                    return false;
                }
            }
        }

        return true;
    }

    static #buildWeightCardHtml(dataAttribute, keyValue, labelText)
    {
        return `
            <div class="question-type-container" data-${dataAttribute}="${keyValue}">
                <div>
                    <label>${labelText}</label>
                    <input type="checkbox">
                </div>
                <div>
                    <label>Weightage</label>
                    <input type="number">
                </div>
            </div>
        `;
    }

    #populateWeightCardList(containerSelector, dataAttribute, enumObject)
    {
        const container = this.querySelector(containerSelector);

        for (const key of Object.keys(enumObject))
        {
            container.innerHTML += FlashcardGenerationFields.#buildWeightCardHtml(dataAttribute, key, enumerationToTitleCase(key));
        }
    }

    #setupUi()
    {
        this.#populateWeightCardList(".question-types-list", "question-type", questionTypes);
        this.#populateWeightCardList(".difficulty-levels-list", "difficulty-level", difficultyLevels);

        const numCardsMethodSelect = this.querySelector(".flashcard-generation-num-cards-method-select");
        const questionTypesMethodSelect = this.querySelector(".flashcard-generation-question-types-selection-method-select");
        const difficultyMethodSelect = this.querySelector(".flashcard-generation-difficulty-selection-method-select");

        convertElementToEnumSelect(numCardsMethodSelect, automationLevels);
        convertElementToEnumSelect(questionTypesMethodSelect, automationLevels);
        convertElementToEnumSelect(difficultyMethodSelect, automationLevels);

        this.#initializeFromSettings();

        this.#handleSelectionMethodVisibility(
            numCardsMethodSelect,
            this.querySelector(".fixed-num-cards-container")
        );

        this.#handleSelectionMethodVisibility(
            questionTypesMethodSelect,
            this.querySelector(".question-types-container.field-container")
        );

        this.#handleSelectionMethodVisibility(
            difficultyMethodSelect,
            this.querySelector(".difficulty-levels-container.field-container")
        );

        this.#bindSettings();
    }

    #initializeFromSettings()
    {
        const settings = this.getSettings();

        const numCardsMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getNumCardsMethod());
        this.querySelector(".flashcard-generation-num-cards-method-select").value = numCardsMethodKey;

        this.querySelector(".flashcard-generation-num-cards-input").value = settings.getNumQuestionsToGenerate();

        const questionTypesMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getQuestionTypesMethod());
        this.querySelector(".flashcard-generation-question-types-selection-method-select").value = questionTypesMethodKey;

        const difficultyMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getDifficultyMethod());
        this.querySelector(".flashcard-generation-difficulty-selection-method-select").value = difficultyMethodKey;

        this.querySelector(".flashcard-generation-mark-cards-for-review-checkbox").checked = settings.getBMarkQuestionsForReview();
        this.querySelector(".flashcard-generation-additional-instructions-input").value = settings.getAdditionalInstructions();

        const questionTypesWithWeights = settings.getQuestionTypesWithWeights();
        const isQuestionTypesEmpty = Object.keys(questionTypesWithWeights).length === 0;

        for (const questionTypeCard of this.querySelectorAll(".question-types-list .question-type-container"))
        {
            const questionTypeKey = questionTypeCard.dataset.questionType;
            const weightValue = questionTypesWithWeights[questionTypeKey];
            const isIncluded = isQuestionTypesEmpty || weightValue !== undefined;

            questionTypeCard.querySelector("input[type='checkbox']").checked = isIncluded;
            questionTypeCard.querySelector("input[type='number']").value = isIncluded && !isQuestionTypesEmpty ? weightValue : 1;
        }

        const questionDifficultyWithWeights = settings.getQuestionDifficultyWithWeights();
        const isDifficultyEmpty = Object.keys(questionDifficultyWithWeights).length === 0;

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            const difficultyKey = difficultyCard.dataset.difficultyLevel;
            const weightValue = questionDifficultyWithWeights[difficultyKey];
            const isIncluded = isDifficultyEmpty || weightValue !== undefined;

            difficultyCard.querySelector("input[type='checkbox']").checked = isIncluded;
            difficultyCard.querySelector("input[type='number']").value = isIncluded && !isDifficultyEmpty ? weightValue : 1;
        }
    }

    #handleSelectionMethodVisibility(methodSelect, contentContainer)
    {
        const applyVisibility = () =>
        {
            contentContainer.style.display = methodSelect.value === "AUTOMATIC" ? "none" : "";
        };

        applyVisibility();
        methodSelect.addEventListener("change", applyVisibility);
        this.#visibilityRefreshers.push(applyVisibility);
    }

    /**
     * Public hook used by AutomaticGenerationPage after a template applies
     * — re-pulls every bound field from the settings instance so the UI
     * matches the template's values. Also re-evaluates manual-vs-automatic
     * visibility for every method-select since assigning select.value
     * programmatically does not fire a change event.
     */
    rebuildFromSettings()
    {
        this.#initializeFromSettings();

        for (const refreshVisibility of this.#visibilityRefreshers)
        {
            refreshVisibility();
        }
    }

    #syncQuestionTypesWithWeights()
    {
        const questionTypesWithWeights = {};

        for (const questionTypeCard of this.querySelectorAll(".question-types-list .question-type-container"))
        {
            const questionTypeKey = questionTypeCard.dataset.questionType;
            const isChecked = questionTypeCard.querySelector("input[type='checkbox']").checked;
            const weightValue = parseFloat(questionTypeCard.querySelector("input[type='number']").value) || 0;

            if (isChecked)
            {
                questionTypesWithWeights[questionTypeKey] = weightValue;
            }
        }

        this.getSettings().setQuestionTypesWithWeights(questionTypesWithWeights);
    }

    #syncDifficultyWeights()
    {
        const questionDifficultyWithWeights = {};

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            const difficultyKey = difficultyCard.dataset.difficultyLevel;
            const isChecked = difficultyCard.querySelector("input[type='checkbox']").checked;
            const weightValue = parseFloat(difficultyCard.querySelector("input[type='number']").value) || 0;

            if (isChecked)
            {
                questionDifficultyWithWeights[difficultyKey] = weightValue;
            }
        }

        this.getSettings().setQuestionDifficultyWithWeights(questionDifficultyWithWeights);
    }

    #bindSettings()
    {
        const numCardsMethodSelect = this.querySelector(".flashcard-generation-num-cards-method-select");
        const numCardsInput = this.querySelector(".flashcard-generation-num-cards-input");
        const questionTypesMethodSelect = this.querySelector(".flashcard-generation-question-types-selection-method-select");
        const difficultyMethodSelect = this.querySelector(".flashcard-generation-difficulty-selection-method-select");
        const markForReviewCheckbox = this.querySelector(".flashcard-generation-mark-cards-for-review-checkbox");
        const additionalInstructionsInput = this.querySelector(".flashcard-generation-additional-instructions-input");

        numCardsMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setNumCardsMethod(automationLevels[numCardsMethodSelect.value]);
        });

        numCardsInput.addEventListener("input", () =>
        {
            this.getSettings().setNumQuestionsToGenerate(parseInt(numCardsInput.value) || 0);
        });

        questionTypesMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setQuestionTypesMethod(automationLevels[questionTypesMethodSelect.value]);
        });

        for (const questionTypeCard of this.querySelectorAll(".question-types-list .question-type-container"))
        {
            questionTypeCard.querySelector("input[type='checkbox']").addEventListener("change", () => this.#syncQuestionTypesWithWeights());
            questionTypeCard.querySelector("input[type='number']").addEventListener("input", () => this.#syncQuestionTypesWithWeights());
        }

        difficultyMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setDifficultyMethod(automationLevels[difficultyMethodSelect.value]);
        });

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            difficultyCard.querySelector("input[type='checkbox']").addEventListener("change", () => this.#syncDifficultyWeights());
            difficultyCard.querySelector("input[type='number']").addEventListener("input", () => this.#syncDifficultyWeights());
        }

        markForReviewCheckbox.addEventListener("change", () =>
        {
            this.getSettings().setBMarkQuestionsForReview(markForReviewCheckbox.checked);
        });

        additionalInstructionsInput.addEventListener("input", () =>
        {
            this.getSettings().setAdditionalInstructions(additionalInstructionsInput.value);
        });

        this.#syncQuestionTypesWithWeights();
        this.#syncDifficultyWeights();
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <h2>Customize Flashcard Generation</h2>

            <div class="num-cards-method-container field-container">
                <label>Number of Cards Method: </label>
                <select class="flashcard-generation-num-cards-method-select"></select>
            </div>

            <div class="fixed-num-cards-container field-container">
                <label>Total Number of Cards to Generate: </label>
                <input type="number" class="flashcard-generation-num-cards-input" min="1" max="100">
            </div>

            <div class="question-types-selection-method-container field-container">
                <label>Question Types Selection Method: </label>
                <select class="flashcard-generation-question-types-selection-method-select"></select>
            </div>

            <div class="question-types-container field-container">
                <label>Question Types to Include: </label>
                <div class="question-types-list"></div>
            </div>

            <div class="difficulty-selection-method-container field-container">
                <label>Difficulty Selection Method: </label>
                <select class="flashcard-generation-difficulty-selection-method-select"></select>
            </div>

            <div class="difficulty-levels-container field-container">
                <label>Difficulty Levels to Include: </label>
                <div class="difficulty-levels-list"></div>
            </div>

            <div class="mark-cards-for-review-container field-container">
                <label>Mark Cards For Review</label>
                <input type="checkbox" class="flashcard-generation-mark-cards-for-review-checkbox">
            </div>

            <div class="additional-instructions-container field-container">
                <label>Additional Instructions (Optional): </label>
                <input type="text" placeholder="Enter Additional Instructions..." class="flashcard-generation-additional-instructions-input">
            </div>
        `;

        this.dataset.rebuildFromSettings = "true";

        this.#setupUi();
    }
}

customElements.define("flashcard-generation-fields", FlashcardGenerationFields);
export default FlashcardGenerationFields;