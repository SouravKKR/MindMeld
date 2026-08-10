import MockTestGenerationSettings from "../../../Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings.js";
import { automationLevels } from "../../../Globals/Enumerations/AutomationLevels.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { difficultyLevels } from "../../../Globals/Enumerations/DifficultyLevels.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { convertElementToEnumSelect } from "../../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import GenerationFields from "./GenerationFields.js";
import MockTestSectionStructureFields from "./MockTestSectionStructureFields.js";
import SettingsInfoButton from "./SettingsInfoButton.js";

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

    // Auto-link state for the two mirror inputs. Flips to true on the
    // user's first `input` event in the corresponding field; after that
    // the auto-mirror from subjectName / numQuestionsPerTest stops
    // overwriting whatever they typed. Reset by rebuildFromSettings()
    // when a template is applied so the new baseline can re-mirror.
    #userTouchedName = false;
    #userTouchedDuration = false;

    validate()
    {
        this._validationMessage = null;

        const settings = this.getSettings();

        if (settings instanceof MockTestGenerationSettings)
        {
            if (settings.getNumQuestionsMethod() == automationLevels.MANUAL)
            {
                const numQuestionsPerTest = settings.getNumQuestionsPerTest();
                if (numQuestionsPerTest <= 5 || numQuestionsPerTest > 250)
                {
                    this._validationMessage = "Mock tests: the number of questions per test must be between 6 and 250.";
                    return false;
                }
            }
        }

        // The section editor knows why a structure is unworkable — an
        // unreachable marks budget, a count that contradicts the paper's own
        // total — and says so in one sentence. Surfacing that beats the generic
        // "make sure the values are valid", which gives the user nothing to act
        // on when the numbers all look individually reasonable.
        const sectionStructureFields = this.querySelector("mock-test-section-structure-fields");
        if (sectionStructureFields !== null && typeof sectionStructureFields.getValidationFailure === "function")
        {
            const sectionFailure = sectionStructureFields.getValidationFailure();
            if (sectionFailure !== null)
            {
                this._validationMessage = `Mock tests: ${sectionFailure}`;
                return false;
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

        this.#handleRecursiveVisibility();
        this.#handleSectionStructureAuthority();

        this.#bindSettings();
    }

    /**
     * Sections and the paper-level question-type weightage both answer "which
     * kinds of question does this paper contain?", and having both on screen is
     * the single biggest source of confusion in this panel — the two can be set
     * to contradict each other, with no indication of which wins.
     *
     * So once a section exists, sections are the answer: the weightage block and
     * its method select are hidden and replaced by a line saying where the
     * setting moved to. The Agent honours the same precedence — GenerateMockTests
     * builds its format mix from the sections and skips the halfway blend it
     * would otherwise apply to a manual mix.
     */
    #handleSectionStructureAuthority()
    {
        const questionTypesMethodContainer = this.querySelector(".question-types-selection-method-container");
        const questionTypesContainer = this.querySelector(".question-types-container.field-container");
        const deferredNotice = this.querySelector(".mock-test-generation-question-types-deferred-notice");
        const sectionStructureFields = this.querySelector("mock-test-section-structure-fields");

        const applyVisibility = () =>
        {
            const sections = this.getSettings().getSectionStructure() || [];
            const bSectionsOwnQuestionTypes = sections.length > 0;

            questionTypesMethodContainer.hidden = bSectionsOwnQuestionTypes;
            questionTypesContainer.hidden = bSectionsOwnQuestionTypes;
            deferredNotice.hidden = !bSectionsOwnQuestionTypes;

            // The section editor needs to know whether the paper's own question
            // count is something the user pinned, because that is the only case
            // where the two numbers have to be reconciled.
            sectionStructureFields.setPaperQuestionCountManual(
                this.getSettings().getNumQuestionsMethod() === automationLevels.MANUAL
            );
        };

        applyVisibility();
        this.addEventListener(AutomaticGenerationEvents.ON_SECTION_STRUCTURE_CHANGED, applyVisibility);
        this.querySelector(".mock-test-generation-num-questions-method-select").addEventListener("change", applyVisibility);
        this.#visibilityRefreshers.push(applyVisibility);
    }

    #handleRecursiveVisibility()
    {
        const recursiveCheckbox = this.querySelector(".mock-test-generation-recursive-checkbox");
        const skipRootContainer = this.querySelector(".mock-test-generation-skip-root-container");

        const applyVisibility = () =>
        {
            skipRootContainer.style.display = recursiveCheckbox.checked ? "" : "none";
        };

        applyVisibility();
        recursiveCheckbox.addEventListener("change", applyVisibility);
        this.#visibilityRefreshers.push(applyVisibility);
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

        // Mock test title — display the stored mockTestName, or mirror the
        // subject name when it's empty so the placeholder feels alive.
        const nameInput = this.querySelector(".mock-test-generation-name-input");
        const storedMockTestName = settings.getMockTestName ? settings.getMockTestName() : "";
        nameInput.value = storedMockTestName.length > 0 ? storedMockTestName : (settings.getSubjectName() || "");

        // Duration — when the persisted value is 0 (auto), show the
        // current per-test question count as the live default. As soon
        // as the user types into either field the link breaks (see
        // #bindSettings).
        const durationInput = this.querySelector(".mock-test-generation-duration-input");
        const storedDuration = settings.getDurationMinutes();
        durationInput.value = storedDuration > 0 ? storedDuration : (settings.getNumQuestionsPerTest() || 0);

        this.querySelector(".mock-test-generation-additional-instructions-input").value = settings.getAdditionalInstructions();
        this.querySelector(".mock-test-generation-show-solving-steps-checkbox").checked = settings.getShowSolvingSteps();
        this.querySelector(".mock-test-generation-recursive-checkbox").checked = settings.getRecursive();
        this.querySelector(".mock-test-generation-skip-root-checkbox").checked = settings.getSkipRootDeck();

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
        // A template apply is the moment to re-engage both auto-mirrors so
        // a new baseline (subject name, question count) flows into the
        // title and duration inputs again.
        this.#userTouchedName = false;
        this.#userTouchedDuration = false;

        this.#initializeFromSettings();

        for (const refreshVisibility of this.#visibilityRefreshers)
        {
            refreshVisibility();
        }
    }

    /**
     * Called by AutomaticGenerationPage when ON_SUBJECT_NAME_CHANGED fires.
     * Mirrors the new subject name into the title input + settings, but
     * only when the user has not manually edited the title field in this
     * session.
     */
    onSubjectNameChanged(subjectName)
    {
        if (this.#userTouchedName)
        {
            return;
        }

        const nameInput = this.querySelector(".mock-test-generation-name-input");
        if (nameInput)
        {
            nameInput.value = subjectName || "";
        }

        // Keep settings.mockTestName mirroring subjectName so the
        // orchestrator sees a real title even when the user never opens
        // this row of the form. The auto-link is silently active until
        // they type in the title input.
        this.getSettings().setMockTestName(subjectName || "");
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

        const durationInput = this.querySelector(".mock-test-generation-duration-input");

        numQuestionsInput.addEventListener("input", () =>
        {
            const newNumQuestions = parseInt(numQuestionsInput.value) || 0;
            this.getSettings().setNumQuestionsPerTest(newNumQuestions);

            // Mirror the question count into the duration input as long as
            // the user has not manually edited the duration. The persisted
            // durationMinutes is updated alongside so the orchestrator sees
            // the final value at submit time.
            if (!this.#userTouchedDuration && newNumQuestions > 0)
            {
                durationInput.value = newNumQuestions;
                this.getSettings().setDurationMinutes(newNumQuestions);
            }
        });

        durationInput.addEventListener("input", () =>
        {
            this.#userTouchedDuration = true;
            const parsedDuration = parseInt(durationInput.value, 10);
            this.getSettings().setDurationMinutes(Number.isFinite(parsedDuration) && parsedDuration >= 0 ? parsedDuration : 0);
        });

        const nameInput = this.querySelector(".mock-test-generation-name-input");
        nameInput.addEventListener("input", () =>
        {
            this.#userTouchedName = true;
            this.getSettings().setMockTestName(nameInput.value);
        });

        additionalInstructionsInput.addEventListener("input", () =>
        {
            this.getSettings().setAdditionalInstructions(additionalInstructionsInput.value);
        });

        const recursiveCheckbox = this.querySelector(".mock-test-generation-recursive-checkbox");
        const skipRootCheckbox = this.querySelector(".mock-test-generation-skip-root-checkbox");

        recursiveCheckbox.addEventListener("change", () =>
        {
            this.getSettings().setRecursive(recursiveCheckbox.checked);
        });

        skipRootCheckbox.addEventListener("change", () =>
        {
            this.getSettings().setSkipRootDeck(skipRootCheckbox.checked);
        });

        this.#syncQuestionTypesWithWeights();
        this.#syncDifficultyWeights();
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <h2>Customize Mock Test Generation</h2>

            <div class="mock-test-generation-past-paper-notice">
                Adding a past paper? Add it under <strong>Information Sources</strong> above and set its type to <strong>Question Paper / Mock Test</strong> — its questions become the pattern these tests are written from.
                <settings-info-button topic="informationSourcesForMockTests"></settings-info-button>
            </div>

            <div class="mock-test-generation-name-container field-container">
                <label>Mock Test Title: </label>
                <input type="text" class="mock-test-generation-name-input" placeholder="(inherits subject name)">
            </div>

            <div class="num-tests-method-container field-container">
                <label>Number of Tests Method: <settings-info-button topic="numberOfTests"></settings-info-button></label>
                <select class="mock-test-generation-num-tests-method-select"></select>
            </div>

            <div class="mock-test-generation-num-tests-container field-container">
                <label>Number of Tests to Generate: </label>
                <input type="number" class="mock-test-generation-num-tests-input" min="1" max="20">
            </div>

            <div class="mock-test-generation-recursive-container field-container">
                <label>Recursive (also generate for every subdeck): <settings-info-button topic="recursiveGeneration"></settings-info-button></label>
                <input type="checkbox" class="mock-test-generation-recursive-checkbox">
            </div>

            <div class="mock-test-generation-skip-root-container field-container">
                <label>Do not generate a mock test for the root deck: </label>
                <input type="checkbox" class="mock-test-generation-skip-root-checkbox">
            </div>

            <div class="difficulty-method-container field-container">
                <label>Test Difficulty Method: <settings-info-button topic="difficultyWeightage"></settings-info-button></label>
                <select class="mock-test-generation-difficulty-method-select"></select>
            </div>

            <div class="difficulty-levels-container field-container">
                <label>Difficulty Levels to Include: </label>
                <div class="difficulty-levels-list"></div>
            </div>

            <div class="question-types-selection-method-container field-container">
                <label>Question Types Method: <settings-info-button topic="questionTypeWeightage"></settings-info-button></label>
                <select class="mock-test-generation-question-types-method-select"></select>
            </div>

            <div class="question-types-container field-container">
                <label>Question Types to Include: </label>
                <div class="question-types-list"></div>
            </div>

            <div class="mock-test-generation-question-types-deferred-notice field-container" hidden>
                <label>Question Types: </label>
                <span class="mock-test-generation-deferred-notice-text">Configured per section, under Section structure below.</span>
            </div>

            <div class="num-questions-method-container field-container">
                <label>Number of Questions Method: <settings-info-button topic="paperQuestionCount"></settings-info-button></label>
                <select class="mock-test-generation-num-questions-method-select"></select>
            </div>

            <div class="mock-test-generation-num-questions-container field-container">
                <label>Number of Questions per Test: </label>
                <input type="number" class="mock-test-generation-num-questions-input" min="1" max="250">
            </div>

            <div class="mock-test-generation-duration-container field-container">
                <label>Duration (minutes): <settings-info-button topic="testDuration"></settings-info-button></label>
                <input type="number" class="mock-test-generation-duration-input" min="0" max="600" step="1" placeholder="0 = auto">
            </div>

            <div class="additional-instructions-container field-container">
                <label>Additional Instructions (Optional): </label>
                <input type="text" placeholder="Enter Additional Instructions..." class="mock-test-generation-additional-instructions-input">
            </div>

            <div class="show-solving-steps-container field-container">
                <label>Show Solving Steps: <settings-info-button topic="showSolvingSteps"></settings-info-button></label>
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