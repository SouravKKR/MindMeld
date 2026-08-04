import DialogBox from "../../CommonComponents/DialogBox.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import { automaticGenerationModes } from "../../Globals/Enumerations/AutomaticGenerationModes.js";
import { automationLevels } from "../../Globals/Enumerations/AutomationLevels.js";
import { questionTypes } from "../../Globals/Enumerations/QuestionTypes.js";
import { difficultyLevels } from "../../Globals/Enumerations/DifficultyLevels.js";
import { studyMaterialDetailLevels } from "../../Globals/Enumerations/StudyMaterialDetailLevels.js";
import { convertElementToEnumSelect } from "../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import FlashcardGenerationFields from "./Components/FlashcardGenerationFields.js";
import GeneralGenerationFields from "./Components/GeneralGenerationFields.js";
import MockTestGenerationFields from "./Components/MockTestGenerationFields.js";
import StudyMaterialGenerationFields from "./Components/StudyMaterialGenerationFields.js";
import AutomaticGenerationEvents from "../../Globals/Events/AutomaticGenerationEvents.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import GenerationTemplate from "../../Globals/Classes/GenerationTemplate.js";
import AiFeatureGate from "../../Globals/Classes/AiFeatureGate.js";
import ErrorCodes from "../../Globals/Constants/ErrorCodes.js";
import CreditNotice from "../../Globals/Classes/Credits/CreditNotice.js";
import MaintenanceNotice from "../../Globals/Classes/MaintenanceNotice.js";
import GenerationNotifier from "../../Globals/Classes/Notifications/GenerationNotifier.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import { generationEstimateOutcomes } from "../../Globals/Enumerations/GenerationEstimateOutcomes.js";
import GenerationEstimateDialog from "./Components/GenerationEstimateDialog.js";
import CreditPurchaseFlow from "../../Globals/Classes/Credits/CreditPurchaseFlow.js";

class AutomaticGenerationPage extends HTMLElement
{
    #parentDeck = null;
    #suppressTemplatedFieldGuard = false;
    #activeTemplateRevertClosure = null;
    #autoFillInFlight = false;

    // Enum key sets used to validate and shape the LLM's Auto Fill recommendations
    // before they are written into the flavor-field settings.
    static #QUESTION_TYPE_KEYS = Object.keys(questionTypes);
    static #DIFFICULTY_KEYS = Object.keys(difficultyLevels);

    /**
     * Called by PageNavigator before connectedCallback.
     * @param {Deck|null} parentDeck - The deck to generate into. Defaults to root if not provided.
     */
    initialize(parentDeck = null)
    {
        this.#parentDeck = parentDeck;
    }

    #setupUi()
    {
        const generalGenerationContainer = this.querySelector(".general-generation-container");
        const flashcardGenerationContainer = this.querySelector(".flashcard-generation-container");
        const studyMaterialGenerationContainer = this.querySelector(".study-material-generation-container");
        const mockTestGenerationContainer = this.querySelector(".mock-test-generation-container");

        generalGenerationContainer.appendChild(GeneralGenerationFields.create());
        flashcardGenerationContainer.appendChild(FlashcardGenerationFields.create());
        studyMaterialGenerationContainer.appendChild(StudyMaterialGenerationFields.create());
        mockTestGenerationContainer.appendChild(MockTestGenerationFields.create());
    }

    #getSecondaryGenerationFields()
    {
        return [
            this.querySelector("flashcard-generation-fields"),
            this.querySelector("study-material-generation-fields"),
            this.querySelector("mock-test-generation-fields")
        ];
    }

    #syncSharedSettings()
    {
        this.addEventListener(AutomaticGenerationEvents.ON_ENHANCE_IMAGES_CHANGED, (event) =>
        {
            const { enhanceImages } = event.detail;

            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setEnhanceImages(enhanceImages);
            }
        });

        this.addEventListener(AutomaticGenerationEvents.ON_INFORMATION_SOURCES_CHANGED, (event) =>
        {
            const { sources } = event.detail;

            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setInformationSources(sources);
            }
        });

        this.addEventListener(AutomaticGenerationEvents.ON_IMAGE_SOURCES_CHANGED, (event) =>
        {
            const { sources } = event.detail;

            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setImageSources(sources);
            }
        });

        this.addEventListener(AutomaticGenerationEvents.ON_SUBJECT_NAME_CHANGED, (event) =>
        {
            const { subjectName } = event.detail;

            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setSubjectName(subjectName);
            }

            // The mock-test field carries a separate auto-linked title input
            // that mirrors the subject name until the user manually edits it.
            // The targeted callback lets the component flip its own dirty
            // flag without leaking it into the generic settings interface.
            const mockTestField = this.querySelector("mock-test-generation-fields");
            if (mockTestField && typeof mockTestField.onSubjectNameChanged === "function")
            {
                mockTestField.onSubjectNameChanged(subjectName);
            }
        });

        this.addEventListener(AutomaticGenerationEvents.ON_EXAM_NAME_CHANGED, (event) =>
        {
            const { examName } = event.detail;

            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setExamName(examName);
            }
        });
    }

    #handleEvents()
    {
        this.#handleGenerationContainerCheckboxEvents();
        this.#handleGenerationModeChange();
        this.#handleTemplateApplication();
        this.#handleTemplatedFieldGuard();
        this.#handleActionButtonEvents();
        this.#handleAutoFillGenerationOptions();
    }

    /**
     * Listens for the GeneralGenerationFields "apply-generation-template"
     * event, patches every settings instance via the template, then asks
     * each flavor-field component to re-pull from settings so the DOM
     * matches the template's values.
     *
     * Stores the revert closure returned by applyToWithRevertHandle so a
     * later TEMPLATE→ADVANCED mode change can roll the patched fields back
     * to their pre-template values. If a template was already active, we
     * revert that one first so the new snapshot captures the user's true
     * pre-template defaults rather than the previous template's values.
     */
    #handleTemplateApplication()
    {
        this.addEventListener("apply-generation-template", (event) =>
        {
            // Template data is fetched from the Dock `/Templates/Get`
            // endpoint by GeneralGenerationFields and forwarded here on
            // the event detail. We wrap it in a GenerationTemplate
            // instance so the apply / revert machinery stays unchanged.
            const templateData = event?.detail?.templateData;

            if (!templateData || typeof templateData !== "object")
            {
                return;
            }

            const template = new GenerationTemplate(templateData);

            const generalFields = this.querySelector("general-generation-fields");
            const flashcardFields = this.querySelector("flashcard-generation-fields");
            const studyMaterialFields = this.querySelector("study-material-generation-fields");
            const mockTestFields = this.querySelector("mock-test-generation-fields");

            if (this.#activeTemplateRevertClosure)
            {
                this.#activeTemplateRevertClosure();
                this.#activeTemplateRevertClosure = null;
            }

            this.#activeTemplateRevertClosure = template.applyToWithRevertHandle({
                general: generalFields?.getSettings(),
                flashcard: flashcardFields?.getSettings(),
                studyMaterial: studyMaterialFields?.getSettings(),
                mockTest: mockTestFields?.getSettings(),
            });

            // The template may have added a web source — propagate to the
            // secondary settings via the existing shared-settings event so
            // their copies stay in sync.
            const refreshedSources = generalFields?.getSettings()?.getInformationSources() || [];
            for (const field of this.#getSecondaryGenerationFields())
            {
                field.getSettings().setInformationSources(refreshedSources);
            }

            // Suppress the mod-guard while we programmatically rewrite the DOM
            // (DOM event handlers will fire ON_TEMPLATED_FIELD_CHANGED on input).
            this.#suppressTemplatedFieldGuard = true;
            try
            {
                this.#dispatchRebuildFromSettings();
            }
            finally
            {
                // Defer flag reset until after the current task queue drains
                // so the spurious input/change events fired during refresh
                // can't trip the guard.
                setTimeout(() =>
                {
                    this.#suppressTemplatedFieldGuard = false;
                }, 0);
            }
        });
    }

    /**
     * Walks every component that has opted into the unified
     * `data-rebuild-from-settings` marker and invokes `rebuildFromSettings()`
     * on it. Replaces the older per-component manual delegation chain —
     * components that mark themselves participate automatically and nested
     * sub-components (the section-structure editor inside the mock-test
     * fields, for example) get rebuilt without the parent having to know
     * about them.
     */
    #dispatchRebuildFromSettings()
    {
        const participants = this.querySelectorAll("[data-rebuild-from-settings]");
        for (const participant of participants)
        {
            participant.rebuildFromSettings?.();
        }
    }

    /**
     * Reverts the currently active template (if any), then propagates the
     * restored info-source list to the secondary settings and refreshes
     * every flavor-field DOM. Called when the user explicitly switches
     * the mode dropdown away from TEMPLATE.
     */
    #revertActiveTemplate()
    {
        if (!this.#activeTemplateRevertClosure)
        {
            return;
        }

        this.#activeTemplateRevertClosure();
        this.#activeTemplateRevertClosure = null;

        const generalFields = this.querySelector("general-generation-fields");
        const flashcardFields = this.querySelector("flashcard-generation-fields");
        const studyMaterialFields = this.querySelector("study-material-generation-fields");
        const mockTestFields = this.querySelector("mock-test-generation-fields");

        const refreshedSources = generalFields?.getSettings()?.getInformationSources() || [];
        for (const field of this.#getSecondaryGenerationFields())
        {
            field.getSettings().setInformationSources(refreshedSources);
        }

        this.#suppressTemplatedFieldGuard = true;
        try
        {
            this.#dispatchRebuildFromSettings();
        }
        finally
        {
            setTimeout(() =>
            {
                this.#suppressTemplatedFieldGuard = false;
            }, 0);
        }

        this.#applyTemplateSelectReset();
    }

    /**
     * If TEMPLATE mode is active and any non-allowlisted control changes,
     * downgrade to ADVANCED. We listen for the explicit
     * ON_TEMPLATED_FIELD_CHANGED dispatch from GeneralGenerationFields,
     * AND for any raw input/change inside the three flavor containers —
     * every field in those containers is non-allowlisted by definition.
     */
    #handleTemplatedFieldGuard()
    {
        const revertIfTemplated = () =>
        {
            if (this.#suppressTemplatedFieldGuard)
            {
                return;
            }

            const generalFields = this.querySelector("general-generation-fields");
            const currentMode = generalFields?.getSettings()?.getGenerationMode();

            if (currentMode === automaticGenerationModes.TEMPLATE)
            {
                generalFields.getSettings().setGenerationMode(automaticGenerationModes.ADVANCED);
                generalFields.rebuildFromSettings();
                this.#applyTemplateSelectReset();

                // The user just edited a templated field — discard the
                // revert closure without invoking it so their edit is
                // preserved (a revert here would clobber the very value
                // they just typed). The mode is now ADVANCED and the user
                // can keep editing freely.
                this.#activeTemplateRevertClosure = null;
            }
        };

        this.addEventListener(AutomaticGenerationEvents.ON_TEMPLATED_FIELD_CHANGED, revertIfTemplated);

        const watchedContainerSelectors = [
            ".flashcard-generation-container",
            ".study-material-generation-container",
            ".mock-test-generation-container"
        ];

        for (const selector of watchedContainerSelectors)
        {
            const container = this.querySelector(selector);
            if (!container)
            {
                continue;
            }
            container.addEventListener("input", revertIfTemplated);
            container.addEventListener("change", revertIfTemplated);
        }
    }

    #applyTemplateSelectReset()
    {
        const generalFields = this.querySelector("general-generation-fields");
        generalFields?.resetTemplatePickerLabel?.();
    }

    /**
     * The "Auto Fill Other Options" helper. GeneralGenerationFields raises a
     * bubbling "auto-fill-generation-options-requested" event; we validate, warn,
     * call the credit-metered /Generate/AutoFillOptions agent task, and apply the
     * returned recommendations to the flavor-field settings.
     */
    #handleAutoFillGenerationOptions()
    {
        this.addEventListener("auto-fill-generation-options-requested", async () =>
        {
            // Re-entry guard: a second click while the confirm dialog is open or a
            // request is in flight must not stack a second dialog / POST / charge.
            // Set BEFORE the first await so the pre-confirm window is covered, and
            // cleared in finally on every exit path.
            if (this.#autoFillInFlight)
            {
                return;
            }
            this.#autoFillInFlight = true;

            const generalFields = this.querySelector("general-generation-fields");
            const autoFillButton = generalFields?.querySelector(".auto-fill-options-button");
            const originalLabel = autoFillButton ? autoFillButton.textContent : "";

            try
            {
                const generalSettings = generalFields?.getSettings();
                const subjectName = (generalSettings?.getSubjectName() || "").trim();

                // The model needs at least a subject to tailor anything sensible.
                if (subjectName.length === 0)
                {
                    await DialogBox.alert("Subject required", "Please enter a Subject Name first so we can tailor the options to it.");
                    return;
                }

                const switchesToAdvanced = this.#currentModeKey() === "SIMPLE";
                const confirmed = await DialogBox.confirm(
                    "Auto Fill Other Options",
                    "This uses AI and will consume a few credits. It overwrites your flashcard, study material and mock test options with AI-recommended values"
                    + (switchesToAdvanced ? " and switches to Advanced mode" : "")
                    + ". Continue?"
                );
                if (!confirmed)
                {
                    return;
                }

                if (autoFillButton)
                {
                    autoFillButton.disabled = true;
                    autoFillButton.textContent = "Thinking…";
                }

                const requestBody =
                {
                    subjectName: subjectName,
                    examName: generalSettings.getExamName() || "",
                    description: generalSettings.getDescription() || "",
                    additionalInstructions: generalSettings.getAdditionalInstructions() || "",
                    mode: this.#currentModeKey(),
                    enabledArtifacts: this.#collectEnabledArtifacts(),
                };

                const response = await fetch("/Generate/AutoFillOptions",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody),
                });

                if (await MaintenanceNotice.handleIfMaintenance(response))
                {
                    return;
                }

                if (response.status === 402)
                {
                    const insufficientDetail = await response.json().catch(() => ({}));
                    await CreditNotice.showInsufficientCredits(insufficientDetail);
                    return;
                }

                if (!response.ok)
                {
                    await DialogBox.alert("Couldn't auto fill", "We couldn't generate recommendations right now. Please try again.");
                    return;
                }

                const responsePayload = await response.json().catch(() => null);
                if (!responsePayload)
                {
                    await DialogBox.alert("Couldn't auto fill", "We couldn't generate recommendations right now. Please try again.");
                    return;
                }

                this.#applyAutoFilledOptions(responsePayload.options || {});
            }
            catch (autoFillError)
            {
                console.error("[AutomaticGenerationPage] Auto fill failed:", autoFillError);
                await DialogBox.alert("Couldn't auto fill", "We couldn't reach the server. Please check your connection.");
            }
            finally
            {
                this.#autoFillInFlight = false;
                if (autoFillButton)
                {
                    autoFillButton.disabled = false;
                    autoFillButton.textContent = originalLabel;
                }
            }
        });
    }

    /**
     * The current generation mode key ("SIMPLE" | "ADVANCED" | "TEMPLATE") read
     * from the mode dropdown — the single source of truth the page already uses.
     */
    #currentModeKey()
    {
        const generationModeSelect = this.querySelector(".generation-mode-select");
        return generationModeSelect ? generationModeSelect.value : "ADVANCED";
    }

    /**
     * Which artifacts are enabled, from each container's enabled checkbox. In
     * SIMPLE the containers are hidden but their checkboxes stay checked, so this
     * correctly reports "produce all three" unless the user unchecked one in
     * Advanced first.
     */
    #collectEnabledArtifacts()
    {
        const isArtifactEnabled = (containerClass) =>
        {
            const container = this.querySelector(containerClass);
            const checkbox = container?.querySelector(".generation-enabled-checkbox");
            return Boolean(checkbox?.checked);
        };

        return {
            flashcards: isArtifactEnabled(".flashcard-generation-container"),
            studyMaterials: isArtifactEnabled(".study-material-generation-container"),
            mockTests: isArtifactEnabled(".mock-test-generation-container"),
        };
    }

    /**
     * Writes the LLM recommendations onto the flavor-field settings, switching
     * SIMPLE → ADVANCED first, then repaints every field from settings. Mirrors
     * #handleTemplateApplication's suppress-guard + rebuild bracket so a TEMPLATE
     * rebuild isn't mistaken for a manual edit and bounced to ADVANCED.
     */
    #applyAutoFilledOptions(options)
    {
        const generalFields = this.querySelector("general-generation-fields");
        const flashcardFields = this.querySelector("flashcard-generation-fields");
        const studyMaterialFields = this.querySelector("study-material-generation-fields");
        const mockTestFields = this.querySelector("mock-test-generation-fields");

        // SIMPLE → ADVANCED: flip the select AND fire a synthetic change so both
        // the component listener (sets generationMode + template-select visibility)
        // and the page's applyMode (reveals the flavor containers) run.
        if (this.#currentModeKey() === "SIMPLE")
        {
            const generationModeSelect = this.querySelector(".generation-mode-select");
            if (generationModeSelect)
            {
                generationModeSelect.value = "ADVANCED";
                generationModeSelect.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }

        const isTemplate = this.#currentModeKey() === "TEMPLATE";
        const enabledArtifacts = this.#collectEnabledArtifacts();

        // General additional instructions: never overwrite a non-empty user value,
        // and in TEMPLATE mode leave the template's instructions untouched.
        if (!isTemplate && typeof options.general_additional_instructions === "string")
        {
            const generalSettings = generalFields.getSettings();
            const existingGeneral = (generalSettings.getAdditionalInstructions() || "").trim();
            const suggestedGeneral = options.general_additional_instructions.trim();
            if (existingGeneral.length === 0 && suggestedGeneral.length > 0)
            {
                generalSettings.setAdditionalInstructions(suggestedGeneral);
            }
        }

        if (enabledArtifacts.flashcards && options.flashcards)
        {
            this.#applyFlashcardOptions(flashcardFields.getSettings(), options.flashcards, isTemplate);
        }
        if (enabledArtifacts.studyMaterials && options.study_materials)
        {
            this.#applyStudyMaterialOptions(studyMaterialFields.getSettings(), options.study_materials, isTemplate);
        }
        if (enabledArtifacts.mockTests && options.mock_tests)
        {
            this.#applyMockTestOptions(mockTestFields.getSettings(), options.mock_tests, isTemplate);
        }

        this.#suppressTemplatedFieldGuard = true;
        try
        {
            this.#dispatchRebuildFromSettings();
        }
        finally
        {
            setTimeout(() =>
            {
                this.#suppressTemplatedFieldGuard = false;
            }, 0);
        }
    }

    /**
     * Flashcard recommendations. Difficulty is tuned in every mode (TEMPLATE
     * included); the rest only outside TEMPLATE. A value is only written when the
     * model supplied a usable one, and the matching method is flipped to MANUAL
     * only then so an empty recommendation never blanks an existing setting.
     */
    #applyFlashcardOptions(settings, flashcardOptions, isTemplate)
    {
        const difficultyMap = this.#buildWeightsMap(flashcardOptions.difficulty_weights, AutomaticGenerationPage.#DIFFICULTY_KEYS);
        if (difficultyMap !== null)
        {
            settings.setQuestionDifficultyWithWeights(difficultyMap);
            settings.setDifficultyMethod(automationLevels.MANUAL);
        }

        if (isTemplate)
        {
            return;
        }

        if (typeof flashcardOptions.number_of_cards === "number")
        {
            settings.setNumQuestionsToGenerate(this.#clampInteger(flashcardOptions.number_of_cards, 6, 500));
            settings.setNumCardsMethod(automationLevels.MANUAL);
        }

        const typeMap = this.#buildWeightsMap(flashcardOptions.question_type_weights, AutomaticGenerationPage.#QUESTION_TYPE_KEYS);
        if (typeMap !== null)
        {
            settings.setQuestionTypesWithWeights(typeMap);
            settings.setQuestionTypesMethod(automationLevels.MANUAL);
        }

        this.#applyArtifactAdditionalInstructions(settings, flashcardOptions.additional_instructions);
    }

    /**
     * Mock-test recommendations. Difficulty weights and number of tests are tuned
     * in every mode (TEMPLATE included); the rest only outside TEMPLATE.
     */
    #applyMockTestOptions(settings, mockTestOptions, isTemplate)
    {
        const difficultyMap = this.#buildWeightsMap(mockTestOptions.difficulty_weights, AutomaticGenerationPage.#DIFFICULTY_KEYS);
        if (difficultyMap !== null)
        {
            // MockTestGenerationSettings stores difficulty as five individual floats.
            settings.setVeryEasyQuestions(difficultyMap.VERY_EASY);
            settings.setEasyQuestions(difficultyMap.EASY);
            settings.setMediumQuestions(difficultyMap.MEDIUM);
            settings.setHardQuestions(difficultyMap.HARD);
            settings.setVeryHardQuestions(difficultyMap.VERY_HARD);
            settings.setDifficultyMethod(automationLevels.MANUAL);
        }

        if (typeof mockTestOptions.number_of_tests === "number")
        {
            settings.setNumberOfTests(this.#clampInteger(mockTestOptions.number_of_tests, 1, 20));
            settings.setNumTestsMethod(automationLevels.MANUAL);
        }

        if (isTemplate)
        {
            return;
        }

        if (typeof mockTestOptions.questions_per_test === "number")
        {
            settings.setNumQuestionsPerTest(this.#clampInteger(mockTestOptions.questions_per_test, 6, 250));
            settings.setNumQuestionsMethod(automationLevels.MANUAL);
        }

        const typeMap = this.#buildWeightsMap(mockTestOptions.question_type_weights, AutomaticGenerationPage.#QUESTION_TYPE_KEYS);
        if (typeMap !== null)
        {
            settings.setQuestionTypesWithWeights(typeMap);
            settings.setQuestionTypesMethod(automationLevels.MANUAL);
        }

        if (typeof mockTestOptions.duration_minutes === "number")
        {
            settings.setDurationMinutes(this.#clampInteger(mockTestOptions.duration_minutes, 0, 600));
        }
        if (typeof mockTestOptions.correct_marks === "number")
        {
            settings.setCorrectMarks(mockTestOptions.correct_marks);
        }
        if (typeof mockTestOptions.wrong_marks === "number")
        {
            settings.setWrongMarks(mockTestOptions.wrong_marks);
        }
        if (typeof mockTestOptions.unattempted_marks === "number")
        {
            settings.setUnattemptedMarks(mockTestOptions.unattempted_marks);
        }
        if (typeof mockTestOptions.partial_marks === "number")
        {
            settings.setPartialMarks(mockTestOptions.partial_marks);
        }

        const sections = this.#buildSections(mockTestOptions.sections);
        if (sections !== null)
        {
            settings.setSectionStructure(sections);
        }

        this.#applyArtifactAdditionalInstructions(settings, mockTestOptions.additional_instructions);
    }

    /**
     * Study-material recommendations. Detail levels are the only structural field
     * (tuned in every mode); instructions only outside TEMPLATE.
     */
    #applyStudyMaterialOptions(settings, studyMaterialOptions, isTemplate)
    {
        const detailLevelValues = this.#buildDetailLevelValues(studyMaterialOptions.detail_levels);
        if (detailLevelValues.length > 0)
        {
            settings.setDetailLevels(detailLevelValues);
        }

        if (isTemplate)
        {
            return;
        }

        this.#applyArtifactAdditionalInstructions(settings, studyMaterialOptions.additional_instructions);
    }

    /**
     * Sets an artifact's additional instructions only when the model supplied a
     * non-empty value AND the field is currently empty — a value the user (or a
     * template) already entered is never overwritten.
     */
    #applyArtifactAdditionalInstructions(settings, instructionText)
    {
        if (typeof instructionText !== "string")
        {
            return;
        }
        const suggested = instructionText.trim();
        if (suggested.length === 0)
        {
            return;
        }
        const existing = (settings.getAdditionalInstructions() || "").trim();
        if (existing.length === 0)
        {
            settings.setAdditionalInstructions(suggested);
        }
    }

    /**
     * Turns a recommendation weight object (named snake_case fields) into a
     * complete enum-keyed weights map (0 for any excluded key, mirroring the
     * template-seed convention so the field components render unticked rows).
     * Returns null when no key carries a positive weight, so the caller skips
     * the setting and leaves the existing one intact.
     */
    #buildWeightsMap(namedWeights, allowedKeys)
    {
        if (!namedWeights || typeof namedWeights !== "object")
        {
            return null;
        }

        const positiveByKey = {};
        let hasPositive = false;
        for (const fieldName of Object.keys(namedWeights))
        {
            const enumKey = fieldName.toUpperCase();
            const weightValue = namedWeights[fieldName];
            if (allowedKeys.includes(enumKey) && typeof weightValue === "number" && Number.isFinite(weightValue) && weightValue > 0)
            {
                positiveByKey[enumKey] = weightValue;
                hasPositive = true;
            }
        }

        if (!hasPositive)
        {
            return null;
        }

        const completeMap = {};
        for (const enumKey of allowedKeys)
        {
            completeMap[enumKey] = positiveByKey[enumKey] ?? 0;
        }
        return completeMap;
    }

    /**
     * Maps the detail-level selection booleans to the integer enum values the
     * study-material settings store, preserving enum order.
     */
    #buildDetailLevelValues(detailLevelSelection)
    {
        if (!detailLevelSelection || typeof detailLevelSelection !== "object")
        {
            return [];
        }

        const detailLevelValues = [];
        for (const levelKey of Object.keys(studyMaterialDetailLevels))
        {
            if (detailLevelSelection[levelKey.toLowerCase()] === true)
            {
                detailLevelValues.push(studyMaterialDetailLevels[levelKey]);
            }
        }
        return detailLevelValues;
    }

    /**
     * Sanitises the recommended section list into the shape the section editor
     * reads: { name, questionTypes:[valid keys], questionCount, totalMarks }.
     * Sections with no valid question type are dropped; returns null when none
     * survive so the caller leaves the existing structure intact.
     */
    #buildSections(rawSections)
    {
        if (!Array.isArray(rawSections))
        {
            return null;
        }

        const sections = [];
        for (const rawSection of rawSections)
        {
            if (!rawSection || typeof rawSection !== "object")
            {
                continue;
            }

            const sectionQuestionTypes = Array.isArray(rawSection.question_types)
                ? rawSection.question_types
                    .map(typeName => String(typeName).toUpperCase())
                    .filter(typeKey => AutomaticGenerationPage.#QUESTION_TYPE_KEYS.includes(typeKey))
                : [];
            if (sectionQuestionTypes.length === 0)
            {
                continue;
            }

            const sectionName = typeof rawSection.name === "string" && rawSection.name.trim().length > 0 ? rawSection.name.trim() : "Section";
            const totalMarks = typeof rawSection.total_marks === "number" && Number.isFinite(rawSection.total_marks) ? rawSection.total_marks : 0;

            sections.push({
                name: sectionName,
                questionTypes: sectionQuestionTypes,
                questionCount: this.#clampInteger(rawSection.question_count, 0, 250),
                totalMarks: totalMarks,
            });
        }

        return sections.length > 0 ? sections : null;
    }

    #clampInteger(value, minimum, maximum)
    {
        let numericValue = parseInt(value, 10);
        if (isNaN(numericValue))
        {
            numericValue = minimum;
        }
        return Math.min(Math.max(numericValue, minimum), maximum);
    }

    /**
     * True while any information-source card is still uploading or being
     * processed server-side. Such a source has no resolved server record yet, so
     * getSources() silently omits it — acting now would either generate from
     * fewer sources than the user chose (the "only 4 of my 5 sources were used"
     * bug) or misreport the in-flight upload as an unfilled form. Every entry
     * point that reads the chosen sources checks this FIRST.
     */
    #hasPendingUploads()
    {
        return Array.from(this.querySelectorAll("information-source-selector"))
            .some(selector => typeof selector.hasPendingUploads === "function" && selector.hasPendingUploads());
    }

    #handleActionButtonEvents()
    {
        const deckLibraryLink = this.querySelector(".automatic-generation-deck-library-link");
        if (deckLibraryLink)
        {
            deckLibraryLink.addEventListener("click", async (clickEvent) =>
            {
                clickEvent.preventDefault();
                await DialogBox.alert(
                    "Coming soon",
                    "The premade deck library is on the way. Browse and buy ready-made decks for popular exams at a fraction of the cost of generating from scratch."
                );
            });
        }

        const generateButton = this.querySelector(".automatic-generation-start-button");

        generateButton.addEventListener("click", async () =>
        {
            // Tutorial demo: never submit to /Generate (no credits, no server,
            // no real task). Jump straight to the progress page, which plays a
            // canned pipeline to completion. The form doesn't need to be filled.
            if (TutorialEngine.isRunning())
            {
                PageNavigator.open("progress-page", "tutorial-demo");
                return;
            }

            // This check MUST come before #validate(). A source that is still
            // uploading or processing has no resolved server record yet, so
            // getSources() omits it and the form reads as though no source was
            // ever chosen — #validate() then fails and reports "fill out all the
            // fields", which is both wrong and unactionable when the only real
            // problem is that the upload has not landed yet.
            if (this.#hasPendingUploads())
            {
                await DialogBox.alert(
                    "Uploads still in progress",
                    "Some of your uploaded documents are still uploading or being processed. Please wait until every source shows a green tick before starting generation."
                );
                return;
            }

            if (!this.#validate())
            {
                await DialogBox.alert("Error", "Please fill out all the fields and make sure the values are valid.");
                return;
            }

            // Paid-deck mode refuses anything that is not a curriculum. Say which
            // source is wrong here rather than letting the server answer with an
            // index the user has to count out against their own list.
            const generalFields = this.querySelector("general-generation-fields");
            const paidDeckSourceProblem = generalFields?.findPaidDeckSourceProblem?.() ?? null;
            if (paidDeckSourceProblem)
            {
                await DialogBox.alert("Can't start generation", paidDeckSourceProblem);
                return;
            }

            console.log("Settings are valid.");

            const generationSettingsMap = this.#buildGenerationSettingsMap();

            // Prompt for notification permission inside the click handler — the
            // browser only shows the permission prompt from a user gesture, and
            // the estimate dialog below awaits, so this has to run first while
            // the original click's transient activation is still live.
            // Fire-and-forget so it never blocks kicking off the generation.
            GenerationNotifier.requestPermission().catch(() => { /* non-fatal */ });

            // Pricing the run is mandatory: nothing reaches /Generate until the
            // user has seen what it will cost and confirmed inside the dialog.
            // Asked BEFORE the button is disabled — cancelling here must leave
            // the page exactly as it was found.
            if (!await this.#confirmEstimateAndStart(generationSettingsMap))
            {
                return;
            }

            generateButton.disabled = true;
            generateButton.textContent = "Starting...";

            try
            {
                const response = await fetch("/Generate",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(generationSettingsMap)
                });

                if (await MaintenanceNotice.handleIfMaintenance(response))
                {
                    return;
                }

                if (response.status === 402)
                {
                    const insufficientDetail = await response.json().catch(() => ({}));
                    await CreditNotice.showInsufficientCredits(insufficientDetail);
                    return;
                }

                // A tier that does not include AUTOMATIC_GENERATION is refused with
                // FEATURE_NOT_IN_PLAN (403) by PlanEntitlementGate. Without this
                // branch it fell through to the generic handler below and the user
                // was told "Failed to start generation. Please try again." — advice
                // that can only ever fail again, because retrying does not change
                // the plan. Key the copy off the server's own requiredTier rather
                // than the client's cached plan, which may be stale.
                if (response.status === 403)
                {
                    const refusalDetail = await response.json().catch(() => ({}));
                    if (refusalDetail?.error === ErrorCodes.FEATURE_NOT_IN_PLAN)
                    {
                        await AiFeatureGate.showFeatureNotInPlanAlert(refusalDetail, "AI generation");
                    }
                    else
                    {
                        await DialogBox.alert("Error", "You are not allowed to start this generation.");
                    }
                    return;
                }

                // A 400 is a settings-validation refusal, and the server already
                // wrote a precise, user-readable reason into the body (see the
                // catch in Generate.js). Showing the generic retry message instead
                // threw that away and told the user to repeat an action that
                // cannot succeed — the paid-deck source-type refusal, for one,
                // names the offending source and what the mode accepts.
                if (response.status === 400)
                {
                    const validationMessage = (await response.text().catch(() => "")).trim();
                    await DialogBox.alert(
                        "Can't start generation",
                        validationMessage.length > 0
                            ? validationMessage
                            : "Some of the generation settings are invalid. Please review them and try again."
                    );
                    return;
                }

                if (!response.ok)
                {
                    await DialogBox.alert("Error", "Failed to start generation. Please try again.");
                    return;
                }

                const { taskId } = await response.json();

                // Track in the background so completion is notified even if the
                // user closes the progress page or backgrounds the tab. Labelled
                // with the subject so the notification is meaningful.
                GenerationNotifier.track(taskId, this.#deriveGenerationLabel());

                PageNavigator.open("progress-page", taskId);
            }
            catch (error)
            {
                console.error("[AutomaticGenerationPage] Generation request failed:", error);
                await DialogBox.alert("Error", "Failed to start generation. Please check your connection.");
            }
            finally
            {
                // Restored on EVERY path, including success. PageNavigator.open
                // only sets display:none on this page — the element is never
                // removed, so connectedCallback (the one place that writes the
                // pristine label) does not run again when the user comes back
                // from the progress page. Leaving the success path unrestored is
                // what wedged the button on "Starting..." with no way to retry.
                generateButton.disabled = false;
                generateButton.textContent = "Start Generation";
            }
        });

    }

    /**
     * Prices the run and asks the user to confirm it before anything is
     * submitted. Returns true only when they chose to start.
     *
     * Buying credits from inside the dialog returns to the same question with a
     * refreshed balance rather than dropping the user back on the form, so a
     * top-up does not cost them their place. Each pass blocks on a modal the
     * user has to click, so the loop cannot spin.
     *
     * @param {object} generationSettingsMap the body /Generate will receive
     * @returns {Promise<boolean>}
     */
    async #confirmEstimateAndStart(generationSettingsMap)
    {
        const exportWarningHtml = this.#buildExportWarningHtml();

        while (true)
        {
            const outcome = await GenerationEstimateDialog.present(generationSettingsMap, exportWarningHtml);

            if (outcome === generationEstimateOutcomes.START)
            {
                return true;
            }

            if (outcome !== generationEstimateOutcomes.BUY_CREDITS)
            {
                return false;
            }

            await CreditPurchaseFlow.run();
        }
    }

    /**
     * Collects the same generation-settings body the Start button posts to
     * /Generate, so the pre-flight estimate is computed against an identical
     * payload. Only the enabled secondary generation types are included.
     */
    /**
     * Derives a human label for the completion notification from the form —
     * subject name preferred, exam name as fallback, generic last.
     * @returns {string}
     */
    #deriveGenerationLabel()
    {
        const generalFields = this.querySelector("general-generation-fields");
        const settings = generalFields?.getSettings?.();
        const subjectName = settings?.getSubjectName?.();
        if (typeof subjectName === "string" && subjectName.trim().length > 0)
        {
            return subjectName.trim();
        }
        const examName = settings?.getExamName?.();
        if (typeof examName === "string" && examName.trim().length > 0)
        {
            return examName.trim();
        }
        return "Your generation";
    }

    #buildGenerationSettingsMap()
    {
        const generationSettingsMap = {};

        const generalFields = this.querySelector("general-generation-fields");
        generationSettingsMap[generalFields.constructor.settingsKey] = generalFields.getSettings().toJson();

        const secondaryContainerSelectors = [
            { containerClass: ".flashcard-generation-container", fieldTag: "flashcard-generation-fields" },
            { containerClass: ".study-material-generation-container", fieldTag: "study-material-generation-fields" },
            { containerClass: ".mock-test-generation-container", fieldTag: "mock-test-generation-fields" }
        ];

        for (const { containerClass, fieldTag } of secondaryContainerSelectors)
        {
            const container = this.querySelector(containerClass);
            const checkbox = container.querySelector(".generation-enabled-checkbox");
            const field = container.querySelector(fieldTag);

            if (checkbox?.checked && field)
            {
                generationSettingsMap[field.constructor.settingsKey] = field.getSettings().toJson();
            }
            // If unchecked, the key is simply absent — the server treats missing keys as null
        }

        generationSettingsMap["parentDeckId"] = this.#parentDeck?.getId() ?? "0";
        return generationSettingsMap;
    }

    #handleGenerationContainerCheckboxEvents()
    {
        const generationContainers = this.querySelectorAll(".generation-container");

        for (const generationContainer of generationContainers)
        {
            const generationEnabledCheckbox = generationContainer.querySelector(".generation-enabled-checkbox");

            generationEnabledCheckbox?.addEventListener("change", () =>
            {
                const generationFields = generationContainer.querySelector(".generation-fields");
                generationFields.style.display = generationEnabledCheckbox.checked ? "block" : "none";
            });
        }
    }

    #handleGenerationModeChange()
    {
        const generationModeSelect = this.querySelector(".generation-mode-select");
        const flashcardGenerationContainer = this.querySelector(".flashcard-generation-container");
        const studyMaterialGenerationContainer = this.querySelector(".study-material-generation-container");
        const mockTestGenerationContainer = this.querySelector(".mock-test-generation-container");

        // SIMPLE hides the three flavor containers. ADVANCED and TEMPLATE
        // both show them — the only difference between those two is whether
        // the template-select dropdown is visible (handled in
        // GeneralGenerationFields).
        const applyMode = (modeKey) =>
        {
            const isSimple = modeKey === "SIMPLE";
            flashcardGenerationContainer.style.display = isSimple ? "none" : "";
            studyMaterialGenerationContainer.style.display = isSimple ? "none" : "";
            mockTestGenerationContainer.style.display = isSimple ? "none" : "";
        };

        applyMode(generationModeSelect.value);

        generationModeSelect.addEventListener("change", () =>
        {
            applyMode(generationModeSelect.value);

            // Leaving TEMPLATE mode via the dropdown rolls back every field
            // the active template patched, so the user starts ADVANCED/SIMPLE
            // from a clean pre-template state rather than inheriting the
            // template's values as the new "defaults".
            const newModeKey = generationModeSelect.value;
            if (newModeKey !== "TEMPLATE")
            {
                this.#revertActiveTemplate();
            }
        });

        // If GeneralGenerationFields was loaded from saved settings with
        // mode == TEMPLATE, downgrade visually to ADVANCED — template name
        // isn't persisted, so we can't restore the dropdown selection.
        const generalFields = this.querySelector("general-generation-fields");
        if (generalFields?.getSettings()?.getGenerationMode() === automaticGenerationModes.TEMPLATE)
        {
            generalFields.getSettings().setGenerationMode(automaticGenerationModes.ADVANCED);
            generalFields.rebuildFromSettings();
        }
    }

    #validate()
    {
        const fields = this.querySelectorAll(".generation-fields");

        for (const field of fields)
        {
            if (!field.validate())
            {
                return false;
            }
        }

        return true;
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");

        // Belt-and-suspenders gate: DeckOptionsContextMenu already checks
        // before navigating here, but a deep-link or future entry point
        // could still land a signed-out visitor on this page. Show the
        // standard sign-in alert and back out so the user is never left
        // staring at a generation form they can't submit.
        if (!AiFeatureGate.isAllowed())
        {
            this.innerHTML = `<header-component title="Automatic Generation"></header-component>`;
            await AiFeatureGate.ensureAllowedOrShowAlert();
            PageNavigator.back();
            return;
        }

        this.innerHTML =
        `
            <header-component title="Automatic Generation"></header-component>
            <div class="automatic-generation-page-scroll-wrapper">
                <div class="automatic-generation-page-container">
                    <div class="general-generation-container generation-container">

                    </div>
                    <div class="flashcard-generation-container generation-container">
                        <div class="generation-type-title-container">
                            <label for="flashcard-generation-checkbox">Flashcard Generation</label>
                            <input type="checkbox" class="flashcard-generation-checkbox generation-enabled-checkbox" checked>
                        </div>
                    </div>

                    <div class="study-material-generation-container generation-container">
                        <div class="generation-type-title-container">
                            <label for="study-material-generation-checkbox">Study Material Generation </label>
                            <input type="checkbox" class="study-material-generation-checkbox generation-enabled-checkbox" checked>
                        </div>
                    </div>

                    <div class="mock-test-generation-container generation-container">
                        <div class="generation-type-title-container">
                            <label for="mock-test-generation-checkbox">Mock Test Generation</label>
                            <input type="checkbox" class="mock-test-generation-checkbox generation-enabled-checkbox" checked>
                        </div>
                    </div>
                </div>
            </div>
            <div class="automatic-generation-action-bar">
                <button class="automatic-generation-start-button">Start Generation</button>
            </div>
            <div class="automatic-generation-deck-library-hint">
                Finding automatic generation expensive? <a class="automatic-generation-deck-library-link" href="#">Buy a premade deck instead</a> which are 90% cheaper.
            </div>
        `;

        this.#setupUi();
        this.#syncSharedSettings();
        this.#handleEvents();
    }

    /**
     * Re-arms the Start button whenever the user returns to this page.
     *
     * PageNavigator.back() reuses the page it pops back to — the element was
     * only hidden, never removed — so connectedCallback does not run again and
     * nothing else would ever repaint the button. The click handler's finally
     * already covers every path forward from here; this is the backstop that
     * also recovers a page left disabled by an older build or by a reload that
     * raced the navigation.
     */
    onPageResumed()
    {
        const generateButton = this.querySelector(".automatic-generation-start-button");
        if (!generateButton)
        {
            return;
        }

        generateButton.disabled = false;
        generateButton.textContent = "Start Generation";
    }

    /**
     * The markup telling the user that generating here permanently removes
     * Export, for the estimate dialog to render.
     *
     * The server marks every deck a run creates AND the deck it was launched
     * from, and that marker is a one-way ratchet — it cannot be cleared from a
     * device. When the run targets an existing deck, the loss reaches cards the
     * user wrote by hand, which is the part worth stopping for.
     *
     * This used to be its own confirm dialog. It now rides in the estimate
     * dialog, ABOVE the cost figures, because two stacked modals in front of one
     * button made the irreversible half of the decision the easier one to click
     * past. The final "Start Generation" press is still the acknowledgement.
     *
     * @returns {string} already-escaped markup
     */
    #buildExportWarningHtml()
    {
        // Generating at the top level creates new decks rather than absorbing an
        // existing one, so there is no hand-made content to lose — the warning
        // is about what is being created. A missing parent means the same thing:
        // #buildGenerationSettingsMap falls back to the root deck id.
        const bTargetsRootDeck = !this.#parentDeck || this.#parentDeck.isRoot?.() === true;

        if (bTargetsRootDeck)
        {
            return "<strong>Generated decks can't be exported.</strong> The decks this creates will hold "
                + "AI-generated study material, so they can't be exported to a file.";
        }

        const deckName = AutomaticGenerationPage.#escapeHtml(this.#parentDeck?.getName?.() ?? "this deck");

        return `<strong>"${deckName}" will no longer be exportable.</strong> Generating into it marks it as holding `
            + "AI-generated study material. It — and everything already inside it, including cards you wrote "
            + "yourself — will no longer be exportable to a file, on any of your devices. This can't be undone.";
    }

    /**
     * DialogBox renders its message as innerHTML, so a deck name has to be
     * escaped before it is interpolated into one.
     */
    static #escapeHtml(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

customElements.define("automatic-generation-page", AutomaticGenerationPage);
export default AutomaticGenerationPage;