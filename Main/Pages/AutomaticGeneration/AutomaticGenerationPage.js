import DialogBox from "../../CommonComponents/DialogBox.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import { automaticGenerationModes } from "../../Globals/Enumerations/AutomaticGenerationModes.js";
import { convertElementToEnumSelect } from "../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import FlashcardGenerationFields from "./Components/FlashcardGenerationFields.js";
import GeneralGenerationFields from "./Components/GeneralGenerationFields.js";
import MockTestGenerationFields from "./Components/MockTestGenerationFields.js";
import StudyMaterialGenerationFields from "./Components/StudyMaterialGenerationFields.js";
import AutomaticGenerationEvents from "../../Globals/Events/AutomaticGenerationEvents.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import GenerationTemplate from "../../Globals/Classes/GenerationTemplate.js";
import AiFeatureGate from "../../Globals/Classes/AiFeatureGate.js";
import CreditNotice from "../../Globals/Classes/Credits/CreditNotice.js";
import MaintenanceNotice from "../../Globals/Classes/MaintenanceNotice.js";
import GenerationNotifier from "../../Globals/Classes/Notifications/GenerationNotifier.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";

class AutomaticGenerationPage extends HTMLElement
{
    #parentDeck = null;
    #suppressTemplatedFieldGuard = false;
    #activeTemplateRevertClosure = null;

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

            if (!this.#validate())
            {
                await DialogBox.alert("Error", "Please fill out all the fields and make sure the values are valid.");
                return;
            }

            console.log("Settings are valid.");

            const generationSettingsMap = this.#buildGenerationSettingsMap();

            // Prompt for notification permission inside the click handler — the
            // browser only shows the permission prompt from a user gesture.
            // Fire-and-forget so it never blocks kicking off the generation.
            GenerationNotifier.requestPermission().catch(() => { /* non-fatal */ });

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
                    generateButton.disabled = false;
                    generateButton.textContent = "Start Generation";
                    return;
                }

                if (response.status === 402)
                {
                    const insufficientDetail = await response.json().catch(() => ({}));
                    await CreditNotice.showInsufficientCredits(insufficientDetail);
                    generateButton.disabled = false;
                    generateButton.textContent = "Start Generation";
                    return;
                }

                if (!response.ok)
                {
                    await DialogBox.alert("Error", "Failed to start generation. Please try again.");
                    generateButton.disabled = false;
                    generateButton.textContent = "Start Generation";
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
                generateButton.disabled = false;
                generateButton.textContent = "Start Generation";
            }
        });

        const computeCostButton = this.querySelector(".automatic-generation-compute-cost-button");

        computeCostButton?.addEventListener("click", async () =>
        {
            if (!this.#validate())
            {
                await DialogBox.alert("Error", "Please fill out all the fields and make sure the values are valid.");
                return;
            }

            const originalLabel = computeCostButton.textContent;
            computeCostButton.disabled = true;
            computeCostButton.textContent = "Estimating…";

            try
            {
                const response = await fetch("/Generate/EstimateCost",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(this.#buildGenerationSettingsMap())
                });

                if (!response.ok)
                {
                    await DialogBox.alert("Couldn't estimate", "We couldn't compute an estimate right now. Please try again.");
                    return;
                }

                const estimate = await response.json();
                await DialogBox.alert("Estimated cost", AutomaticGenerationPage.#buildEstimateMessage(estimate));
            }
            catch (estimateError)
            {
                console.error("[AutomaticGenerationPage] Cost estimate failed:", estimateError);
                await DialogBox.alert("Couldn't estimate", "We couldn't reach the server. Please check your connection.");
            }
            finally
            {
                computeCostButton.disabled = false;
                computeCostButton.textContent = originalLabel;
            }
        });
    }

    /**
     * Collects the same generation-settings body the Start button posts to
     * /Generate, so the Compute Cost button can estimate against an identical
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

    static #buildEstimateMessage(estimate)
    {
        if (!estimate || estimate.estimatedCredits === null || estimate.estimatedCredits === undefined)
        {
            return "Credit pricing isn't configured yet, so we can't estimate the cost.";
        }

        const credits = estimate.estimatedCredits;
        const moneySuffix = (typeof estimate.pricePerCredit === "number" && estimate.currency)
            ? ` (≈ ${estimate.currency} ${(credits * estimate.pricePerCredit).toFixed(2)})`
            : "";

        const breakdownHtml = (Array.isArray(estimate.breakdown) ? estimate.breakdown : [])
            .map(item => `<div style="display:flex;justify-content:space-between;gap:16px;"><span>${item.label}</span><span>${item.credits} cr</span></div>`)
            .join("");

        return `
            <div style="font-size:16px;font-weight:700;margin-bottom:6px;">≈ ${credits} credits${moneySuffix}</div>
            <div style="font-size:13px;opacity:0.8;margin-bottom:12px;">Estimated range: ${estimate.low}–${estimate.high} credits</div>
            ${breakdownHtml ? `<div style="font-size:13px;display:flex;flex-direction:column;gap:4px;margin-bottom:12px;">${breakdownHtml}</div>` : ""}
            <div style="font-size:12px;opacity:0.7;">This is an estimate (±10%). Your actual credits are charged from real usage during generation.</div>
        `;
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
                <button class="automatic-generation-compute-cost-button">Compute Cost</button>
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
}

customElements.define("automatic-generation-page", AutomaticGenerationPage);
export default AutomaticGenerationPage;