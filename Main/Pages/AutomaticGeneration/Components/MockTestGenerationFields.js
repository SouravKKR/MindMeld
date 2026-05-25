import MockTestGenerationSettings from "../../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings.js";
import { automationLevels } from "../../../Globals/Enumerations/AutomationLevels.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { difficultyLevels } from "../../../Globals/Enumerations/DifficultyLevels.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { convertElementToEnumSelect } from "../../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import GenerationFields from "./GenerationFields.js";
import MockTestSectionStructureFields from "./MockTestSectionStructureFields.js";

class MockTestGenerationFields extends GenerationFields
{
    static settingsClass = MockTestGenerationSettings;
    static settingsKey = "mockTestGeneration";
    static taskType = taskTypes.GENERATE_MOCK_TESTS;
    static tagName = "mock-test-generation-fields";

    // Each entry is a closure that re-applies visibility for one
    // (method-select, dependent-container) pair. Re-invoked from
    // refreshFromSettings — programmatic select.value writes do not fire
    // the change event, so the dependent container would otherwise stay
    // hidden after a template flips a method to MANUAL.
    #visibilityRefreshers = [];

    validate()
    {
        const settings = this.getSettings();

        if (settings instanceof MockTestGenerationSettings)
        {
            if (settings.getNumQuestionsMethod() == automationLevels.MANUAL)
            {
                const numQuestionsPerTest = settings.getNumQuestionsPerTest();
                if (numQuestionsPerTest <= 5 || numQuestionsPerTest > 250)
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
            container.innerHTML += MockTestGenerationFields.#buildWeightCardHtml(dataAttribute, key, enumerationToTitleCase(key));
        }
    }

    #setupUi()
    {
        this.#populateWeightCardList(".question-types-list", "question-type", questionTypes);
        this.#populateWeightCardList(".difficulty-levels-list", "difficulty-level", difficultyLevels);

        const numTestsMethodSelect = this.querySelector(".mock-test-generation-num-tests-method-select");
        const difficultyMethodSelect = this.querySelector(".mock-test-generation-difficulty-method-select");
        const questionTypesMethodSelect = this.querySelector(".mock-test-generation-question-types-method-select");
        const numQuestionsMethodSelect = this.querySelector(".mock-test-generation-num-questions-method-select");

        convertElementToEnumSelect(numTestsMethodSelect, automationLevels);
        convertElementToEnumSelect(difficultyMethodSelect, automationLevels);
        convertElementToEnumSelect(questionTypesMethodSelect, automationLevels);
        convertElementToEnumSelect(numQuestionsMethodSelect, automationLevels);

        const sectionStructureFields = this.querySelector("mock-test-section-structure-fields");
        sectionStructureFields.setSettings(this.getSettings());

        this.#initializeFromSettings();

        this.#handleSelectionMethodVisibility(
            numTestsMethodSelect,
            this.querySelector(".mock-test-generation-num-tests-container")
        );

        this.#handleSelectionMethodVisibility(
            difficultyMethodSelect,
            this.querySelector(".difficulty-levels-container.field-container")
        );

        this.#handleSelectionMethodVisibility(
            questionTypesMethodSelect,
            this.querySelector(".question-types-container.field-container")
        );

        this.#handleSelectionMethodVisibility(
            numQuestionsMethodSelect,
            this.querySelector(".mock-test-generation-num-questions-container")
        );

        this.#bindSettings();
    }

    #initializeFromSettings()
    {
        const settings = this.getSettings();

        const numTestsMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getNumTestsMethod());
        this.querySelector(".mock-test-generation-num-tests-method-select").value = numTestsMethodKey;

        this.querySelector(".mock-test-generation-num-tests-input").value = settings.getNumberOfTests();

        const difficultyMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getDifficultyMethod());
        this.querySelector(".mock-test-generation-difficulty-method-select").value = difficultyMethodKey;

        const questionTypesMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getQuestionTypesMethod());
        this.querySelector(".mock-test-generation-question-types-method-select").value = questionTypesMethodKey;

        const numQuestionsMethodKey = Object.keys(automationLevels).find(key => automationLevels[key] === settings.getNumQuestionsMethod());
        this.querySelector(".mock-test-generation-num-questions-method-select").value = numQuestionsMethodKey;

        this.querySelector(".mock-test-generation-num-questions-input").value = settings.getNumQuestionsPerTest();
        this.querySelector(".mock-test-generation-duration-input").value = settings.getDurationMinutes();
        this.querySelector(".mock-test-generation-additional-instructions-input").value = settings.getAdditionalInstructions();
        this.querySelector(".mock-test-generation-show-solving-steps-checkbox").checked = settings.getShowSolvingSteps();

        // Difficulty — MockTestGenerationSettings still uses individual property getters
        const difficultyKeyToGetterMap =
        {
            VERY_EASY: "getVeryEasyQuestions",
            EASY: "getEasyQuestions",
            MEDIUM: "getMediumQuestions",
            HARD: "getHardQuestions",
            VERY_HARD: "getVeryHardQuestions"
        };

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            const difficultyKey = difficultyCard.dataset.difficultyLevel;
            const getterName = difficultyKeyToGetterMap[difficultyKey];
            const weightValue = settings[getterName]();

            difficultyCard.querySelector("input[type='checkbox']").checked = weightValue > 0;
            difficultyCard.querySelector("input[type='number']").value = weightValue;
        }

        const questionTypesWithWeights = settings.getQuestionTypesWithWeights();
        const isQuestionTypesEmpty = Object.keys(questionTypesWithWeights).length === 0;

        for (const questionTypeCard of this.querySelectorAll(".question-types-list .question-type-container"))
        {
            const questionTypeKey = questionTypeCard.dataset.questionType;
            const weightValue = questionTypesWithWeights[questionTypeKey];
            // A weight of 0 is "not included" — templates use it to flag
            // a question type the exam profile excludes (e.g. NEET UG
            // zeroes every non-MCQ slot). Difficulty above already uses
            // `> 0`; this keeps question-type rendering consistent.
            const isIncluded = isQuestionTypesEmpty || (typeof weightValue === "number" && weightValue > 0);

            questionTypeCard.querySelector("input[type='checkbox']").checked = isIncluded;
            questionTypeCard.querySelector("input[type='number']").value = isIncluded && !isQuestionTypesEmpty ? weightValue : 1;
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
     * Public hook used by AutomaticGenerationPage's apply-template dispatcher.
     * Walks every bound field from the settings instance, then forces each
     * method-select to re-evaluate the visibility of its dependent container —
     * assigning select.value programmatically does not fire a change event, so
     * without this the MANUAL-only sub-component would remain hidden after a
     * template applies.
     *
     * Children that also need to react (the section-structure editor below)
     * carry their own `data-rebuild-from-settings` marker and are picked up by
     * the page-level dispatcher directly; no manual delegation here.
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
        const difficultyKeyToSetterMap =
        {
            VERY_EASY: "setVeryEasyQuestions",
            EASY: "setEasyQuestions",
            MEDIUM: "setMediumQuestions",
            HARD: "setHardQuestions",
            VERY_HARD: "setVeryHardQuestions"
        };

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            const difficultyKey = difficultyCard.dataset.difficultyLevel;
            const setterName = difficultyKeyToSetterMap[difficultyKey];
            const isChecked = difficultyCard.querySelector("input[type='checkbox']").checked;
            const weightValue = parseFloat(difficultyCard.querySelector("input[type='number']").value) || 0;

            this.getSettings()[setterName](isChecked ? weightValue : 0);
        }
    }

    #bindSettings()
    {
        const numTestsMethodSelect = this.querySelector(".mock-test-generation-num-tests-method-select");
        const numTestsInput = this.querySelector(".mock-test-generation-num-tests-input");
        const difficultyMethodSelect = this.querySelector(".mock-test-generation-difficulty-method-select");
        const questionTypesMethodSelect = this.querySelector(".mock-test-generation-question-types-method-select");
        const numQuestionsMethodSelect = this.querySelector(".mock-test-generation-num-questions-method-select");
        const numQuestionsInput = this.querySelector(".mock-test-generation-num-questions-input");
        const additionalInstructionsInput = this.querySelector(".mock-test-generation-additional-instructions-input");
        const showSolvingStepsCheckbox = this.querySelector(".mock-test-generation-show-solving-steps-checkbox");

        numTestsMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setNumTestsMethod(automationLevels[numTestsMethodSelect.value]);
        });

        showSolvingStepsCheckbox.addEventListener("change", () =>
        {
            this.getSettings().setShowSolvingSteps(showSolvingStepsCheckbox.checked);
        });

        numTestsInput.addEventListener("input", () =>
        {
            this.getSettings().setNumberOfTests(parseInt(numTestsInput.value) || 0);
        });

        difficultyMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setDifficultyMethod(automationLevels[difficultyMethodSelect.value]);
        });

        for (const difficultyCard of this.querySelectorAll(".difficulty-levels-list .question-type-container"))
        {
            difficultyCard.querySelector("input[type='checkbox']").addEventListener("change", () => this.#syncDifficultyWeights());
            difficultyCard.querySelector("input[type='number']").addEventListener("input", () => this.#syncDifficultyWeights());
        }

        questionTypesMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setQuestionTypesMethod(automationLevels[questionTypesMethodSelect.value]);
        });

        for (const questionTypeCard of this.querySelectorAll(".question-types-list .question-type-container"))
        {
            questionTypeCard.querySelector("input[type='checkbox']").addEventListener("change", () => this.#syncQuestionTypesWithWeights());
            questionTypeCard.querySelector("input[type='number']").addEventListener("input", () => this.#syncQuestionTypesWithWeights());
        }

        numQuestionsMethodSelect.addEventListener("change", () =>
        {
            this.getSettings().setNumQuestionsMethod(automationLevels[numQuestionsMethodSelect.value]);
        });

        numQuestionsInput.addEventListener("input", () =>
        {
            this.getSettings().setNumQuestionsPerTest(parseInt(numQuestionsInput.value) || 0);
        });

        const durationInput = this.querySelector(".mock-test-generation-duration-input");
        durationInput.addEventListener("input", () =>
        {
            const parsedDuration = parseInt(durationInput.value, 10);
            this.getSettings().setDurationMinutes(Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : 0);
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
            <h2>Customize Mock Test Generation</h2>

            <div class="num-tests-method-container field-container">
                <label>Number of Tests Method: </label>
                <select class="mock-test-generation-num-tests-method-select"></select>
            </div>

            <div class="mock-test-generation-num-tests-container field-container">
                <label>Number of Tests to Generate: </label>
                <input type="number" class="mock-test-generation-num-tests-input" min="1" max="20">
            </div>

            <div class="difficulty-method-container field-container">
                <label>Test Difficulty Method: </label>
                <select class="mock-test-generation-difficulty-method-select"></select>
            </div>

            <div class="difficulty-levels-container field-container">
                <label>Difficulty Levels to Include: </label>
                <div class="difficulty-levels-list"></div>
            </div>

            <div class="question-types-selection-method-container field-container">
                <label>Question Types Method: </label>
                <select class="mock-test-generation-question-types-method-select"></select>
            </div>

            <div class="question-types-container field-container">
                <label>Question Types to Include: </label>
                <div class="question-types-list"></div>
            </div>

            <div class="num-questions-method-container field-container">
                <label>Number of Questions Method: </label>
                <select class="mock-test-generation-num-questions-method-select"></select>
            </div>

            <div class="mock-test-generation-num-questions-container field-container">
                <label>Number of Questions per Test: </label>
                <input type="number" class="mock-test-generation-num-questions-input" min="1" max="250">
            </div>

            <div class="mock-test-generation-duration-container field-container">
                <label title="How long the user has to attempt the mock test, in minutes. Leave 0 to let the LLM pick a duration that fits the question pool.">Duration (minutes): </label>
                <input type="number" class="mock-test-generation-duration-input" min="0" max="600" step="1" placeholder="0 = auto">
            </div>

            <div class="additional-instructions-container field-container">
                <label>Additional Instructions (Optional): </label>
                <input type="text" placeholder="Enter Additional Instructions..." class="mock-test-generation-additional-instructions-input">
            </div>

            <div class="show-solving-steps-container field-container">
                <label title="When on, the LLM produces step-by-step working for solvable questions (math, physics, etc.) and leaves the field blank for purely subjective answers. You can hand-edit each step set in the mock-test editor later.">Show Solving Steps: </label>
                <input type="checkbox" class="mock-test-generation-show-solving-steps-checkbox">
            </div>

            <mock-test-section-structure-fields></mock-test-section-structure-fields>
        `;

        this.dataset.rebuildFromSettings = "true";

        this.#setupUi();
    }
}

customElements.define("mock-test-generation-fields", MockTestGenerationFields);
export default MockTestGenerationFields;