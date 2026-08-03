import GeneralGenerationSettings from "../../../Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings.js";
import { automaticGenerationModes } from "../../../Globals/Enumerations/AutomaticGenerationModes.js";
import { convertElementToEnumSelect } from "../../../Globals/UtilityFunctions/ConvertElementToEnumSelect.js";
import InformationSourceSelector from "./InformationSourceSelector.js";
import GenerationFields from "./GenerationFields.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { informationSourceTypes } from "../../../Globals/Enumerations/InformationSourceTypes.js";
import { userRoles } from "../../../Globals/Enumerations/UserRoles.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import TemplatePickerDialog from "../../../CommonComponents/TemplatePickerDialog.js";


class GeneralGenerationFields extends GenerationFields
{
    static settingsClass = GeneralGenerationSettings;
    static settingsKey = "generalGeneration";
    static taskType = taskTypes.PREPARE_FOR_GENERATION;
    static tagName = "general-generation-fields";

    static TEMPLATE_PICKER_PLACEHOLDER_LABEL = "— Choose a template —";
    static TEMPLATE_GET_ENDPOINT = "/Templates/Get";

    #imageSourceSelector = null;
    #inheritImageCurriculumCheckbox = null;
    #captureImagesCheckbox = null;
    #imageSourcesSelectorContainer = null;
    #inheritImageCurriculumContainer = null;
    #templateContainer = null;
    #templatePickerButton = null;
    #templatePickerLabel = null;
    #suppressImageUserEdits = false;

    validate()
    {
        const settings = this.getSettings();

        if (settings instanceof GeneralGenerationSettings)
        {
            if (settings.getSubjectName().length === 0)
            {
                return false;
            }

            const informationSources = settings.getInformationSources() || [];
            const description = (settings.getDescription() || "").trim();

            if (informationSources.length === 0 && description.length === 0)
            {
                return false;
            }
        }

        return true;
    }

    /**
     * Reports the first reason paid-deck mode would refuse the current sources,
     * so the page can say which row is wrong before the request is sent.
     *
     * Narrowing the "add source" dropdown does not cover this: a row added
     * before the mode was ticked keeps whatever type it had, and the server then
     * refuses the whole run with an index the user has to count out by hand.
     * This is a UX mirror of PaidDeckGenerationGate, never a replacement — the
     * gate stays authoritative, because a dropdown constrains nothing.
     *
     * @returns {string|null} a user-readable reason, or null when the sources are acceptable
     */
    findPaidDeckSourceProblem()
    {
        const settings = this.getSettings();
        if (!(settings instanceof GeneralGenerationSettings) || settings.getPaidDeckMode() !== true)
        {
            return null;
        }

        const informationSources = settings.getInformationSources() || [];

        if (informationSources.length === 0)
        {
            return "Paid deck mode needs at least one curriculum or syllabus source. "
                + "Generating from a description alone would fall back to open web sources, "
                + "which is exactly what this mode exists to prevent.";
        }

        for (const extractableSource of informationSources)
        {
            const informationSource = extractableSource?.getInformationSource?.();
            if (!informationSource || informationSource.getSourceType() === informationSourceTypes.CURRICULUM_OR_SYLLABUS)
            {
                continue;
            }

            const sourceName = informationSource.getName?.() || "One of your sources";

            return `"${sourceName}" is not set to Curriculum Or Syllabus. Paid deck mode accepts `
                + "only curriculum/syllabus sources, so change that source's type using its dropdown, "
                + "or remove it.";
        }

        return null;
    }

    #setupUi()
    {
        const generationModeSelect = this.querySelector(".generation-mode-select");
        convertElementToEnumSelect(generationModeSelect, automaticGenerationModes);

        this.#templatePickerButton = this.querySelector(".template-picker-button");
        this.#templatePickerLabel = this.querySelector(".template-picker-button-label");

        this.#initializeFromSettings();
        this.#bindSettings();
        this.#bindAutoFillButton();
        this.#applyCaptureImagesVisibility();
        this.#applyTemplateSelectVisibility();
    }

    /**
     * The "Auto Fill Other Options" helper only raises a bubbling request — the
     * page owns the cross-settings work (mode switch, applying the recommended
     * values to every flavor-field settings instance, and rebuilding the DOM),
     * so this component stays unaware of the other settings. Deliberately does
     * NOT flag a templated-field change: the page handles the mode transition.
     */
    #bindAutoFillButton()
    {
        const autoFillButton = this.querySelector(".auto-fill-options-button");
        autoFillButton.addEventListener("click", () =>
        {
            this.dispatchEvent(new CustomEvent("auto-fill-generation-options-requested", { bubbles: true }));
        });
    }

    /**
     * Resets the template-picker button back to its placeholder label.
     * Called by the page when the user switches mode away from TEMPLATE
     * or when an auto-flip discards the active template.
     */
    resetTemplatePickerLabel()
    {
        if (this.#templatePickerLabel)
        {
            this.#templatePickerLabel.textContent = GeneralGenerationFields.TEMPLATE_PICKER_PLACEHOLDER_LABEL;
        }
    }

    #initializeFromSettings()
    {
        const settings = this.getSettings();

        const generationModeKey = Object.keys(automaticGenerationModes).find(
            key => automaticGenerationModes[key] === settings.getGenerationMode()
        );

        this.querySelector(".generation-mode-select").value = generationModeKey;
        this.querySelector(".subject-name-input").value = settings.getSubjectName();
        this.querySelector(".exam-name-input").value = settings.getExamName();
        this.querySelector(".enhance-images-checkbox").checked = settings.getEnhanceImages();
        this.querySelector(".capture-images-checkbox").checked = settings.getCaptureImagesEnabled();
        this.querySelector(".inherit-image-curriculum-checkbox").checked = settings.getInheritImageCurriculumFromInformationSources();
        this.querySelector(".good-quality-deck-short-names-checkbox").checked = settings.getGoodQualityDeckShortNames();
        this.querySelector(".paid-deck-mode-checkbox").checked = settings.getPaidDeckMode() === true;
        this.querySelector(".additional-instructions-input").value = settings.getAdditionalInstructions();
        this.querySelector(".description-input").value = settings.getDescription();
    }

    /**
     * Reveals and binds the admin-only "Paid deck" toggle.
     *
     * The row is hidden for everyone else, but hiding it is presentation only —
     * Generate.js re-authorises the flag against the stored user record and
     * ValidateGenerationSettings re-checks the source types, so a client that
     * unhides the row or posts the flag directly is refused server-side. This
     * exists so the option is discoverable by the people who may use it, not to
     * keep anyone out.
     *
     * Checking it also narrows the source picker to CURRICULUM_OR_SYLLABUS. That
     * is the same restriction the server enforces, applied early so the user is
     * told what the mode requires while they are choosing, rather than after
     * they submit.
     */
    #bindPaidDeckModeCheckbox()
    {
        const paidDeckModeContainer = this.querySelector(".paid-deck-mode-container");
        const paidDeckModeCheckbox = this.querySelector(".paid-deck-mode-checkbox");

        if (!paidDeckModeContainer || !paidDeckModeCheckbox)
        {
            return;
        }

        const currentUser = window["user"];
        const bIsAdministrator = !!currentUser
            && typeof currentUser.getRole === "function"
            && currentUser.getRole() === userRoles.ADMIN;

        paidDeckModeContainer.hidden = !bIsAdministrator;

        if (!bIsAdministrator)
        {
            return;
        }

        paidDeckModeCheckbox.addEventListener("change", () =>
        {
            const bPaidDeckMode = paidDeckModeCheckbox.checked;
            this.getSettings().setPaidDeckMode(bPaidDeckMode);
            this.#applyPaidDeckSourceRestriction(bPaidDeckMode);
            this.#flagTemplatedFieldChanged();
        });

        this.#applyPaidDeckSourceRestriction(paidDeckModeCheckbox.checked);
    }

    /**
     * Narrows (or restores) the information-source picker for paid-deck mode and
     * disables the image-source controls, which the mode does not accept.
     */
    #applyPaidDeckSourceRestriction(bPaidDeckMode)
    {
        const informationSourceSelector = this.querySelector(".information-sources-selector-container information-source-selector");

        if (informationSourceSelector && typeof informationSourceSelector.setAllowedSourceTypes === "function")
        {
            informationSourceSelector.setAllowedSourceTypes(
                bPaidDeckMode ? [informationSourceTypes.CURRICULUM_OR_SYLLABUS] : null
            );
        }

        const imageSourcesContainer = this.querySelector(".image-sources-container");
        const captureImagesContainer = this.querySelector(".capture-images-container");
        const enhanceImagesContainer = this.querySelector(".enhance-images-container");
        const inheritImageCurriculumContainer = this.querySelector(".inherit-image-curriculum-container");

        // Image sources have no meaning in this mode — PrepareImages generates
        // the visuals rather than extracting them — so the pickers go away.
        for (const container of [imageSourcesContainer, enhanceImagesContainer, inheritImageCurriculumContainer])
        {
            if (container)
            {
                container.hidden = bPaidDeckMode;
            }
        }

        if (bPaidDeckMode)
        {
            // Turn the inherit setting OFF and clear the list, rather than only
            // hiding the controls. Inherit defaults to on, so leaving it set
            // would keep mirroring the syllabus into the image sources on every
            // subsequent edit and send a payload whose image sources the server
            // then has to strip. Fixing it here means the request says what the
            // mode actually means.
            const inheritImageCurriculumCheckbox = this.querySelector(".inherit-image-curriculum-checkbox");
            if (inheritImageCurriculumCheckbox)
            {
                inheritImageCurriculumCheckbox.checked = false;
            }

            this.getSettings().setInheritImageCurriculumFromInformationSources(false);
            this.getSettings().setImageSources([]);

            const imageSourceSelector = this.querySelector(".image-sources-selector-container information-source-selector");
            if (imageSourceSelector && typeof imageSourceSelector.setSources === "function")
            {
                imageSourceSelector.setSources([]);
            }
        }

        // "Capture Images / Diagrams" stays visible and meaningful — in this mode
        // it is the switch that decides whether visuals are generated at all.
        if (captureImagesContainer)
        {
            captureImagesContainer.hidden = false;
        }
    }

    /**
     * Public hook used by AutomaticGenerationPage after applying a template.
     * Re-pulls every bound field from the settings instance so the UI
     * reflects the new values without rebuilding the DOM.
     */
    rebuildFromSettings()
    {
        const informationSourceSelector = this.querySelector(".information-sources-selector-container information-source-selector");
        if (informationSourceSelector)
        {
            this.#suppressImageUserEdits = true;
            try
            {
                informationSourceSelector.setSources(this.getSettings().getInformationSources() || []);
            }
            finally
            {
                this.#suppressImageUserEdits = false;
            }
        }

        if (this.#imageSourceSelector)
        {
            this.#suppressImageUserEdits = true;
            try
            {
                this.#imageSourceSelector.setSources(this.getSettings().getImageSources() || []);
            }
            finally
            {
                this.#suppressImageUserEdits = false;
            }
        }

        this.#initializeFromSettings();
        this.#applyCaptureImagesVisibility();
        this.#applyTemplateSelectVisibility();
    }

    #applyCaptureImagesVisibility()
    {
        if (!this.#captureImagesCheckbox || !this.#imageSourcesSelectorContainer || !this.#inheritImageCurriculumContainer)
        {
            return;
        }

        const enabled = this.#captureImagesCheckbox.checked;
        this.#imageSourcesSelectorContainer.style.display   = enabled ? "" : "none";
        this.#inheritImageCurriculumContainer.style.display = enabled ? "" : "none";
    }

    #applyTemplateSelectVisibility()
    {
        if (!this.#templateContainer)
        {
            return;
        }

        const mode = this.getSettings().getGenerationMode();
        this.#templateContainer.style.display = (mode === automaticGenerationModes.TEMPLATE) ? "" : "none";
    }

    #bindSettings()
    {
        const generationModeSelect = this.querySelector(".generation-mode-select");
        const informationSourceSelector = this.querySelector(".information-sources-selector-container information-source-selector");
        const imageSourceSelector = this.querySelector(".image-sources-selector-container information-source-selector");
        const subjectNameInput = this.querySelector(".subject-name-input");
        const examNameInput = this.querySelector(".exam-name-input");
        const enhanceImagesCheckbox = this.querySelector(".enhance-images-checkbox");
        const captureImagesCheckbox = this.querySelector(".capture-images-checkbox");
        const inheritImageCurriculumCheckbox = this.querySelector(".inherit-image-curriculum-checkbox");
        const additionalInstructionsInput = this.querySelector(".additional-instructions-input");
        const descriptionInput = this.querySelector(".description-input");

        this.#imageSourceSelector = imageSourceSelector;
        this.#inheritImageCurriculumCheckbox = inheritImageCurriculumCheckbox;
        this.#captureImagesCheckbox = captureImagesCheckbox;
        this.#imageSourcesSelectorContainer = this.querySelector(".image-sources-selector-container");
        this.#inheritImageCurriculumContainer = this.querySelector(".inherit-image-curriculum-container");
        this.#templateContainer = this.querySelector(".template-container");

        generationModeSelect.addEventListener("change", () =>
        {
            const newMode = automaticGenerationModes[generationModeSelect.value];
            this.getSettings().setGenerationMode(newMode);
            this.#applyTemplateSelectVisibility();

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_GENERATION_MODE_CHANGED,
            {
                detail:  {mode: newMode},
                bubbles: true
            }));
        });

        this.#templatePickerButton.addEventListener("click", async () =>
        {
            const selectedKey = await TemplatePickerDialog.show();
            if (!selectedKey)
            {
                return;
            }

            // The picker dialog resolves a key — the full template data
            // (patches, etc.) lives in Mongo and is fetched separately.
            // The button label is updated with the server-returned
            // displayName so it matches the catalogue rather than relying
            // on a stale client-side registry.
            let templateData;
            try
            {
                const requestUrl = `${GeneralGenerationFields.TEMPLATE_GET_ENDPOINT}?key=${encodeURIComponent(selectedKey)}`;
                const response = await fetch(requestUrl, { credentials: "same-origin" });
                if (!response.ok)
                {
                    console.error(`[GeneralGenerationFields] /Templates/Get returned ${response.status} for key ${selectedKey}`);
                    return;
                }
                templateData = await response.json();
            }
            catch (fetchError)
            {
                console.error(`[GeneralGenerationFields] /Templates/Get failed for key ${selectedKey}: ${fetchError.message}`);
                return;
            }

            if (!templateData || typeof templateData !== "object")
            {
                console.error(`[GeneralGenerationFields] /Templates/Get returned invalid payload for key ${selectedKey}`);
                return;
            }

            this.#templatePickerLabel.textContent = templateData.displayName || selectedKey;

            this.dispatchEvent(new CustomEvent("apply-generation-template",
            {
                detail:
                {
                    templateKey: selectedKey,
                    templateData: templateData
                },
                bubbles: true
            }));
        });

        informationSourceSelector.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, () =>
        {
            const sources = informationSourceSelector.getSources();
            this.getSettings().setInformationSources(sources);

            // Mirror to image sources when the inherit checkbox is on
            this.#mirrorToImageSourcesIfLinked(sources);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INFORMATION_SOURCES_CHANGED,
            {
                detail: {sources},
                bubbles: true
            }));
        });

        imageSourceSelector.addEventListener(AutomaticGenerationEvents.ON_SOURCES_CHANGED, () =>
        {
            const sources = imageSourceSelector.getSources();
            this.getSettings().setImageSources(sources);

            if (!this.#suppressImageUserEdits && inheritImageCurriculumCheckbox.checked)
            {
                // Manual edit breaks the inheritance link
                inheritImageCurriculumCheckbox.checked = false;
                this.getSettings().setInheritImageCurriculumFromInformationSources(false);
                this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INHERIT_IMAGE_CURRICULUM_CHANGED,
                {
                    detail: {inheritImageCurriculum: false},
                    bubbles: true
                }));
            }

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_IMAGE_SOURCES_CHANGED,
            {
                detail: {sources},
                bubbles: true
            }));
        });

        subjectNameInput.addEventListener("input", () =>
        {
            const subjectName = subjectNameInput.value;
            this.getSettings().setSubjectName(subjectName);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_SUBJECT_NAME_CHANGED,
            {
                detail: {subjectName},
                bubbles: true
            }));
        });

        examNameInput.addEventListener("input", () =>
        {
            const examName = examNameInput.value;
            this.getSettings().setExamName(examName);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_EXAM_NAME_CHANGED,
            {
                detail: {examName},
                bubbles: true
            }));

            this.#flagTemplatedFieldChanged();
        });

        enhanceImagesCheckbox.addEventListener("change", () =>
        {
            const enhanceImages = enhanceImagesCheckbox.checked;
            this.getSettings().setEnhanceImages(enhanceImages);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_ENHANCE_IMAGES_CHANGED,
            {
                detail: {enhanceImages},
                bubbles: true
            }));

            this.#flagTemplatedFieldChanged();
        });

        captureImagesCheckbox.addEventListener("change", () =>
        {
            const captureImagesEnabled = captureImagesCheckbox.checked;
            this.getSettings().setCaptureImagesEnabled(captureImagesEnabled);

            if (!captureImagesEnabled)
            {
                // Clear the image sources so a stale list can't be sent to the server.
                this.#suppressImageUserEdits = true;
                try
                {
                    this.#imageSourceSelector?.setSources([]);
                    this.getSettings().setImageSources([]);
                }
                finally
                {
                    this.#suppressImageUserEdits = false;
                }

                this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_IMAGE_SOURCES_CHANGED,
                {
                    detail: {sources: []},
                    bubbles: true
                }));
            }
            else if (inheritImageCurriculumCheckbox.checked)
            {
                // Re-establish the inherit link so the image-source list catches up.
                this.#mirrorToImageSourcesIfLinked(informationSourceSelector.getSources());
            }

            this.#applyCaptureImagesVisibility();

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_CAPTURE_IMAGES_CHANGED,
            {
                detail: {captureImagesEnabled},
                bubbles: true
            }));
        });

        const goodQualityDeckShortNamesCheckbox = this.querySelector(".good-quality-deck-short-names-checkbox");

        goodQualityDeckShortNamesCheckbox.addEventListener("change", () =>
        {
            const goodQualityDeckShortNames = goodQualityDeckShortNamesCheckbox.checked;
            this.getSettings().setGoodQualityDeckShortNames(goodQualityDeckShortNames);
            this.#flagTemplatedFieldChanged();
        });

        this.#bindPaidDeckModeCheckbox();

        inheritImageCurriculumCheckbox.addEventListener("change", () =>
        {
            const inheritImageCurriculum = inheritImageCurriculumCheckbox.checked;
            this.getSettings().setInheritImageCurriculumFromInformationSources(inheritImageCurriculum);

            if (inheritImageCurriculum)
            {
                this.#mirrorToImageSourcesIfLinked(informationSourceSelector.getSources());
            }

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_INHERIT_IMAGE_CURRICULUM_CHANGED,
            {
                detail: {inheritImageCurriculum},
                bubbles: true
            }));

            this.#flagTemplatedFieldChanged();
        });

        additionalInstructionsInput.addEventListener("input", () =>
        {
            this.getSettings().setAdditionalInstructions(additionalInstructionsInput.value);
            this.#flagTemplatedFieldChanged();
        });

        descriptionInput.addEventListener("input", () =>
        {
            const description = descriptionInput.value;
            this.getSettings().setDescription(description);

            this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_DESCRIPTION_CHANGED,
            {
                detail: {description},
                bubbles: true
            }));
        });
    }

    /**
     * Signals that a field NOT on the template-allowlist has changed. The
     * page-level mod-guard listens for this and reverts TEMPLATE → ADVANCED.
     * Allowlist (does not flag): subjectName, description, informationSources,
     * imageSources, captureImagesEnabled.
     */
    #flagTemplatedFieldChanged()
    {
        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_TEMPLATED_FIELD_CHANGED,
        {
            bubbles: true
        }));
    }

    #mirrorToImageSourcesIfLinked(informationSources)
    {
        if (!this.#inheritImageCurriculumCheckbox || !this.#imageSourceSelector)
        {
            return;
        }

        if (!this.#inheritImageCurriculumCheckbox.checked)
        {
            return;
        }

        // Merge — never replace. Previously this overwrote the entire
        // image-source list with the information-source list, which wiped
        // any manually-added image sources (singletons, extra documents,
        // URLs) the user had picked. The user's complaint was "all my
        // existing selections go away". The merge below keeps every
        // existing image source AND ensures every information source is
        // also represented; matching info sources update the existing
        // image-source entry so page-range edits propagate.
        const existingImageSources = this.#imageSourceSelector.getSources();
        const informationSourceFingerprintToExtractable = new Map();
        for (const informationSource of informationSources)
        {
            informationSourceFingerprintToExtractable.set(
                GeneralGenerationFields.#computeExtractableFingerprint(informationSource),
                informationSource,
            );
        }

        const mergedSources = [];
        const seenFingerprints = new Set();

        // Pass 1 — preserve existing image sources, but for each one
        // whose fingerprint matches an information source, swap in the
        // info-source extractable so the page ranges stay current.
        for (const existingImageSource of existingImageSources)
        {
            const fingerprint = GeneralGenerationFields.#computeExtractableFingerprint(existingImageSource);
            if (informationSourceFingerprintToExtractable.has(fingerprint))
            {
                mergedSources.push(informationSourceFingerprintToExtractable.get(fingerprint));
            }
            else
            {
                mergedSources.push(existingImageSource);
            }
            seenFingerprints.add(fingerprint);
        }

        // Pass 2 — append any information sources not already present.
        for (const informationSource of informationSources)
        {
            const fingerprint = GeneralGenerationFields.#computeExtractableFingerprint(informationSource);
            if (!seenFingerprints.has(fingerprint))
            {
                mergedSources.push(informationSource);
                seenFingerprints.add(fingerprint);
            }
        }

        // Suppress the "user edited it directly" detection while we mirror programmatically
        this.#suppressImageUserEdits = true;
        try
        {
            this.#imageSourceSelector.setSources(mergedSources);
            this.getSettings().setImageSources(this.#imageSourceSelector.getSources());
        }
        finally
        {
            this.#suppressImageUserEdits = false;
        }

        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_IMAGE_SOURCES_CHANGED,
        {
            detail: {sources: this.getSettings().getImageSources()},
            bubbles: true
        }));
    }

    /**
     * Produces a stable identity key for dedup across mirror passes.
     * Documents identify by their persisted source id; URL sources by
     * the URL text; singleton types (ANYWHERE_ON_THE_INTERNET,
     * AI_GENERATED, REPUTED_EXTERNAL_SOURCES) by type alone since at
     * most one of each can exist in a settings instance.
     */
    static #computeExtractableFingerprint(extractableInformationSource)
    {
        const informationSource = extractableInformationSource.getInformationSource();
        const sourceTypeValue   = informationSource.getSourceType();

        if (sourceTypeValue === informationSourceTypes.PROVIDED_DOCUMENTS
            || sourceTypeValue === informationSourceTypes.CURRICULUM_OR_SYLLABUS)
        {
            return `doc:${informationSource.getId()}`;
        }

        if (sourceTypeValue === informationSourceTypes.SPECIFIC_URL_ON_THE_INTERNET)
        {
            return `url:${informationSource.getName() ?? ""}`;
        }

        return `singleton:${sourceTypeValue}`;
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <h2>Adjust General Settings</h2>

            <div class="generation-mode-container field-container">
                <label>Generation Mode: </label>
                <select class="generation-mode-select">
                </select>
            </div>
            <div class="template-container field-container" style="display: none;">
                <label>Template: </label>
                <button type="button" class="template-picker-button">
                    <span class="template-picker-button-label">${GeneralGenerationFields.TEMPLATE_PICKER_PLACEHOLDER_LABEL}</span>
                    <span class="template-picker-button-chevron">▾</span>
                </button>
            </div>
            <div class="paid-deck-mode-container field-container" hidden>
                <label title="Admin only. Generates first-party commercial content from the curriculum itself: only a curriculum/syllabus source is accepted, chunk content is written from model knowledge rather than retrieved from an upload, visuals are generated, and the deck lands unpublished behind a review gate.">Paid Deck (admin): </label>
                <input type="checkbox" class="paid-deck-mode-checkbox">
                <span class="credit-warning-note">⚠ Curriculum/syllabus source only</span>
            </div>
            <div class="information-source-container field-container information-sources-selector-container">
                <label>Information Sources: </label>
                <information-source-selector></information-source-selector>
            </div>
            <div class="capture-images-container field-container">
                <label title="When unchecked, no image or diagram extraction will run. Image sources will be ignored.">Capture Images / Diagrams: </label>
                <input type="checkbox" class="capture-images-checkbox">
                <span class="credit-warning-note">⚠ Consumes a lot of credits</span>
            </div>
            <div class="image-sources-container field-container image-sources-selector-container">
                <label>Image Sources: </label>
                <information-source-selector></information-source-selector>
            </div>
            <div class="enhance-images-container field-container">
                <label>Enhance Images: </label>
                <input type="checkbox" class="enhance-images-checkbox">
                <span class="credit-warning-note">⚠ Consumes a lot of credits</span>
            </div>
            <div class="inherit-image-curriculum-container field-container">
                <label for="inherit-image-sources-checkbox">Inherit Image Sources From Information Sources: </label>
                <input id="inherit-image-sources-checkbox" type="checkbox" class="inherit-image-curriculum-checkbox">
            </div>
            <div class="good-quality-deck-short-names-container field-container">
                <label title="Uses an extra AI pass to craft readable short names for each generated deck instead of mechanical abbreviations.">Good Quality Deck Short Names (uses a few extra credits): </label>
                <input type="checkbox" class="good-quality-deck-short-names-checkbox">
            </div>
            <div class="subject-name-container field-container">
                <label>Subject Name: </label>
                <input type="text" placeholder="Example: Biology" class="subject-name-input">
            </div>
            <div class="exam-name-container field-container">
                <label>Exam Name (Optional): </label>
                <input type="text" placeholder="Example: CBSE class 10 board exam" class="exam-name-input">
            </div>
            <div class="description-container field-container">
                <label>Description (Required when no information source is provided): </label>
                <textarea class="description-input" placeholder="Describe what you want to be generated..." rows="4"></textarea>
            </div>
            <div class="additional-instructions-container field-container">
                <label>Additional Instructions (Optional): </label>
                <input type="text" placeholder="Enter Additional Instructions..." class="additional-instructions-input">
            </div>
            <div class="auto-fill-options-container field-container">
                <button type="button" class="auto-fill-options-button">Auto Fill Other Options</button>
                <span class="credit-warning-note">⚠ Uses AI and a few credits to configure the other options for you</span>
            </div>
        `;

        this.dataset.rebuildFromSettings = "true";

        this.#setupUi();
    }
}


customElements.define("general-generation-fields", GeneralGenerationFields);
export default GeneralGenerationFields;
