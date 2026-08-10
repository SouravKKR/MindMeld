import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { sectionQuestionCountModes } from "../../../Globals/Enumerations/SectionQuestionCountModes.js";
import { sectionMarksModes } from "../../../Globals/Enumerations/SectionMarksModes.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";
import MockTestSectionGeometry from "../../../Globals/Classes/MockTestSectionGeometry.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";
import SettingsInfoButton from "./SettingsInfoButton.js";


/**
 * MockTestSectionStructureFields
 *
 * Unified editor for a mock test's structural + scoring layout:
 *
 *   1. Paper-default marking rule       (correct / wrong / unattempted / partial)
 *   2. Per-question-type marking overrides (optional)
 *   3. Section structure                 (ordered list of sections — each carries
 *                                         name, question types, how many questions,
 *                                         how they are marked, and optional
 *                                         marking-rule overrides)
 *
 * Sections are the primary structural concept for templated papers: JEE
 * Advanced's three sections, GATE's 1-mark/2-mark tiers, CBSE's mark-band
 * sections, Engineering papers' unit-based sections.
 *
 * A section describes three quantities — how many questions, what each is
 * worth, and what the section totals — but the user only ever enters two of
 * them. Which two is the marks mode's job, and the third is DERIVED and shown
 * read-only. That is what makes "questions worth 4-10 marks, some number of
 * them summing to 20" expressible, and it is also why nothing in this editor
 * can be edited into disagreeing with itself. All of that arithmetic lives in
 * MockTestSectionGeometry, which Dock re-checks and the assembler realises.
 *
 * Blank marking-rule inputs are treated as "inherit from parent tier" — the
 * corresponding key is omitted from the override entry so the scoring engine
 * resolves it through the section -> type -> paper hierarchy.
 *
 * The component is bound to a MockTestGenerationSettings instance via
 * setSettings(). Every change in the DOM writes back through the settings
 * setters and raises ON_SECTION_STRUCTURE_CHANGED so the surrounding mock-test
 * panel can react; template-driven changes call rebuildFromSettings() to pull
 * fresh values into the DOM.
 */
class MockTestSectionStructureFields extends HTMLElement
{
    static tagName = "mock-test-section-structure-fields";

    static SECTION_HELP_TEXT = "Sections are the parts your paper is divided into. Each one holds certain question types, a number of questions, and its own marking. Add none and the paper is grouped automatically.";

    static DEFAULT_MARKS_PER_QUESTION = 4;

    static DEFAULT_QUESTION_COUNT = 10;

    #settings = null;

    setSettings(settings)
    {
        this.#settings = settings;
        if (this.isConnected)
        {
            this.rebuildFromSettings();
        }
    }

    rebuildFromSettings()
    {
        if (!this.#settings)
        {
            return;
        }

        this.querySelector(".mock-test-marking-correct-input").value = this.#settings.getCorrectMarks();
        this.querySelector(".mock-test-marking-wrong-input").value = this.#settings.getWrongMarks();
        this.querySelector(".mock-test-marking-unattempted-input").value = this.#settings.getUnattemptedMarks();
        this.querySelector(".mock-test-marking-partial-input").value = this.#settings.getPartialMarks();

        this.#renderTypeOverrideRows();
        this.#renderSectionRows();
        this.#updateSectionSummary();
    }

    /**
     * The first thing wrong with the configured sections, phrased for the user,
     * or null when everything is coherent. MockTestGenerationFields.validate()
     * blocks submission on this, and Dock re-derives the same answer from the
     * submitted payload.
     */
    getValidationFailure()
    {
        if (!this.#settings)
        {
            return null;
        }

        return MockTestSectionGeometry.describeStructureValidationFailure(
            this.#settings.getSectionStructure() || [],
            this.#settings.getNumQuestionsPerTest(),
            this.#bIsPaperQuestionCountManual()
        );
    }

    connectedCallback()
    {
        this.dataset.rebuildFromSettings = "true";

        this.innerHTML =
        `
            <div class="mock-test-marking-section">
                <div class="mock-test-marking-section-header">Marking &amp; Section Structure</div>

                <div class="mock-test-marking-subgroup">
                    <div class="mock-test-marking-subgroup-title">Default rule (applies to the whole paper)</div>
                    <div class="mock-test-marking-row">
                        <label class="mock-test-marking-row-label">Correct (max marks)</label>
                        <input type="number" step="0.01" class="mock-test-marking-correct-input">
                    </div>
                    <div class="mock-test-marking-row">
                        <label class="mock-test-marking-row-label">Wrong / negative marks <span class="mock-test-marking-row-hint">(use a negative number for penalties)</span></label>
                        <input type="number" step="0.01" class="mock-test-marking-wrong-input">
                    </div>
                    <div class="mock-test-marking-row">
                        <label class="mock-test-marking-row-label">Unattempted</label>
                        <input type="number" step="0.01" class="mock-test-marking-unattempted-input">
                    </div>
                    <div class="mock-test-marking-row">
                        <label class="mock-test-marking-row-label">Partial (multi-correct)</label>
                        <input type="number" step="0.01" class="mock-test-marking-partial-input">
                    </div>
                </div>

                <div class="mock-test-marking-subgroup">
                    <div class="mock-test-marking-subgroup-title">Per-question-type overrides (optional)</div>
                    <div class="mock-test-marking-type-override-list"></div>
                    <button type="button" class="mock-test-marking-add-type-override-button">+ Add type override</button>
                </div>

                <div class="mock-test-marking-subgroup mock-test-section-structure-subgroup">
                    <div class="mock-test-marking-subgroup-title">
                        <span>Section structure</span>
                        <settings-info-button topic="sectionStructure"></settings-info-button>
                    </div>
                    <div class="mock-test-marking-section-hint">${MockTestSectionStructureFields.SECTION_HELP_TEXT}</div>
                    <div class="mock-test-marking-section-override-list"></div>
                    <div class="mock-test-section-structure-summary" aria-live="polite"></div>
                    <button type="button" class="mock-test-marking-add-section-override-button">+ Add section</button>
                </div>
            </div>
        `;

        this.#bindDefaultInputs();
        this.#bindAddTypeOverrideButton();
        this.#bindAddSectionButton();

        if (this.#settings)
        {
            this.rebuildFromSettings();
        }
    }

    /**
     * The paper's own question count only has to be reconciled with the
     * sections when the user pinned it themselves. The enumeration is not
     * imported here — MockTestGenerationFields owns that mapping and passes the
     * resolved flag down through the settings object it shares with us.
     */
    #bIsPaperQuestionCountManual()
    {
        return this.dataset.paperQuestionCountManual === "true";
    }

    setPaperQuestionCountManual(bIsManual)
    {
        this.dataset.paperQuestionCountManual = bIsManual ? "true" : "false";
        this.#updateSectionSummary();
    }

    #notifyStructureChanged()
    {
        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_SECTION_STRUCTURE_CHANGED, { bubbles: true }));
    }

    #bindDefaultInputs()
    {
        const correctInput = this.querySelector(".mock-test-marking-correct-input");
        const wrongInput = this.querySelector(".mock-test-marking-wrong-input");
        const unattemptedInput = this.querySelector(".mock-test-marking-unattempted-input");
        const partialInput = this.querySelector(".mock-test-marking-partial-input");

        correctInput.addEventListener("input", () =>
        {
            this.#settings?.setCorrectMarks(MockTestSectionStructureFields.#parseFloatOrDefault(correctInput.value, 0));
            this.#updateSectionSummary();
        });
        wrongInput.addEventListener("input", () =>
        {
            this.#settings?.setWrongMarks(MockTestSectionStructureFields.#parseFloatOrDefault(wrongInput.value, 0));
        });
        unattemptedInput.addEventListener("input", () =>
        {
            this.#settings?.setUnattemptedMarks(MockTestSectionStructureFields.#parseFloatOrDefault(unattemptedInput.value, 0));
        });
        partialInput.addEventListener("input", () =>
        {
            this.#settings?.setPartialMarks(MockTestSectionStructureFields.#parseFloatOrDefault(partialInput.value, 0));
        });
    }

    #bindAddTypeOverrideButton()
    {
        const addButton = this.querySelector(".mock-test-marking-add-type-override-button");
        addButton.addEventListener("click", () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const overrides = { ...(this.#settings.getPerTypeMarkingOverrides() || {}) };
            const firstUnusedTypeKey = MockTestSectionStructureFields.#findFirstUnusedTypeKey(overrides);
            if (firstUnusedTypeKey === null)
            {
                return;
            }
            overrides[firstUnusedTypeKey] = {};
            this.#settings.setPerTypeMarkingOverrides(overrides);
            this.#renderTypeOverrideRows();
        });
    }

    #bindAddSectionButton()
    {
        const addButton = this.querySelector(".mock-test-marking-add-section-override-button");
        addButton.addEventListener("click", () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const sections = [...(this.#settings.getSectionStructure() || [])];

            // A new section starts complete rather than blank. An empty section
            // is invalid by every rule below, so seeding zeroes would greet the
            // user with an error they did not cause; these defaults describe a
            // small, valid 10-question section they can then edit.
            sections.push({
                name: `Section ${sections.length + 1}`,
                questionTypes: [],
                questionCountMode: sectionQuestionCountModes.FIXED,
                questionCount: MockTestSectionStructureFields.DEFAULT_QUESTION_COUNT,
                marksMode: sectionMarksModes.UNIFORM_PER_QUESTION,
                marksPerQuestion: this.#resolveDefaultMarksPerQuestion(),
                totalMarks: MockTestSectionStructureFields.DEFAULT_QUESTION_COUNT * this.#resolveDefaultMarksPerQuestion()
            });

            this.#settings.setSectionStructure(sections);
            this.#renderSectionRows();
            this.#updateSectionSummary();
            this.#notifyStructureChanged();
        });
    }

    #resolveDefaultMarksPerQuestion()
    {
        const paperCorrectMarks = this.#settings ? this.#settings.getCorrectMarks() : 0;
        return (Number.isFinite(paperCorrectMarks) && paperCorrectMarks > 0)
            ? paperCorrectMarks
            : MockTestSectionStructureFields.DEFAULT_MARKS_PER_QUESTION;
    }

    #renderTypeOverrideRows()
    {
        const list = this.querySelector(".mock-test-marking-type-override-list");
        list.innerHTML = "";

        const overrides = this.#settings?.getPerTypeMarkingOverrides() || {};

        for (const typeKey of Object.keys(overrides))
        {
            list.appendChild(this.#buildTypeOverrideRow(typeKey, overrides[typeKey] || {}));
        }
    }

    #buildTypeOverrideRow(currentTypeKey, ruleOverride)
    {
        const rowElement = document.createElement("div");
        rowElement.className = "mock-test-marking-override-row";

        const typeSelectHtml = Object.keys(questionTypes)
            .map(typeKey => `<option value="${typeKey}"${typeKey === currentTypeKey ? " selected" : ""}>${enumerationToTitleCase(typeKey)}</option>`)
            .join("");

        rowElement.innerHTML =
        `
            <select class="mock-test-marking-override-type-select">${typeSelectHtml}</select>
            <label class="mock-test-marking-override-field">
                <span>Correct</span>
                <input type="number" step="0.01" class="mock-test-marking-override-correct-input" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.correctMarks)}">
            </label>
            <label class="mock-test-marking-override-field">
                <span>Wrong</span>
                <input type="number" step="0.01" class="mock-test-marking-override-wrong-input" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.wrongMarks)}">
            </label>
            <label class="mock-test-marking-override-field">
                <span>Unattempted</span>
                <input type="number" step="0.01" class="mock-test-marking-override-unattempted-input" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.unattemptedMarks)}">
            </label>
            <label class="mock-test-marking-override-field">
                <span>Partial</span>
                <input type="number" step="0.01" class="mock-test-marking-override-partial-input" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.partialMarks)}">
            </label>
            <button type="button" class="mock-test-marking-override-remove-button" title="Remove">&times;</button>
        `;

        const typeSelect = rowElement.querySelector(".mock-test-marking-override-type-select");
        const correctInput = rowElement.querySelector(".mock-test-marking-override-correct-input");
        const wrongInput = rowElement.querySelector(".mock-test-marking-override-wrong-input");
        const unattemptedInput = rowElement.querySelector(".mock-test-marking-override-unattempted-input");
        const partialInput = rowElement.querySelector(".mock-test-marking-override-partial-input");
        const removeButton = rowElement.querySelector(".mock-test-marking-override-remove-button");

        const writeBack = () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const previousOverrides = { ...(this.#settings.getPerTypeMarkingOverrides() || {}) };
            delete previousOverrides[currentTypeKey];

            const updatedRule = {};
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedRule, "correctMarks", correctInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedRule, "wrongMarks", wrongInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedRule, "unattemptedMarks", unattemptedInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedRule, "partialMarks", partialInput.value);

            const newTypeKey = typeSelect.value;
            previousOverrides[newTypeKey] = updatedRule;
            currentTypeKey = newTypeKey;
            this.#settings.setPerTypeMarkingOverrides(previousOverrides);
        };

        typeSelect.addEventListener("change", writeBack);
        correctInput.addEventListener("input", writeBack);
        wrongInput.addEventListener("input", writeBack);
        unattemptedInput.addEventListener("input", writeBack);
        partialInput.addEventListener("input", writeBack);

        removeButton.addEventListener("click", () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const previousOverrides = { ...(this.#settings.getPerTypeMarkingOverrides() || {}) };
            delete previousOverrides[currentTypeKey];
            this.#settings.setPerTypeMarkingOverrides(previousOverrides);
            this.#renderTypeOverrideRows();
        });

        return rowElement;
    }

    #renderSectionRows()
    {
        const list = this.querySelector(".mock-test-marking-section-override-list");
        list.innerHTML = "";

        const sections = this.#settings?.getSectionStructure() || [];

        for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex++)
        {
            list.appendChild(this.#buildSectionRow(sectionIndex, sections[sectionIndex] || {}));
        }
    }

    #buildSectionRow(sectionIndex, sectionEntry)
    {
        const rowElement = document.createElement("div");
        rowElement.className = "mock-test-marking-section-override-row";

        const currentTypeKeys = Array.isArray(sectionEntry.questionTypes) ? sectionEntry.questionTypes : [];

        const typeCheckboxesHtml = Object.keys(questionTypes)
            .map((typeKey) =>
            {
                const bIsChecked = currentTypeKeys.includes(typeKey);
                return `
                    <label class="mock-test-marking-section-type-checkbox">
                        <input type="checkbox" value="${typeKey}"${bIsChecked ? " checked" : ""}>
                        <span>${enumerationToTitleCase(typeKey)}</span>
                    </label>
                `;
            })
            .join("");

        const resolvedCountMode = MockTestSectionGeometry.resolveQuestionCountMode(sectionEntry);
        const resolvedMarksMode = MockTestSectionGeometry.resolveMarksMode(sectionEntry);
        const marksBand = MockTestSectionGeometry.resolveMarksPerQuestionBand(sectionEntry);

        // Legacy entries carry only questionCount + totalMarks; the geometry
        // back-derives what each question was worth so the field is populated
        // rather than blank on a template saved before marks modes existed.
        const resolvedMarksPerQuestion = MockTestSectionGeometry.resolveMarksPerQuestion(sectionEntry, this.#resolveDefaultMarksPerQuestion());

        const bIsMarksRangeMode = resolvedMarksMode === sectionMarksModes.RANGE_PER_QUESTION;
        const bIsCountRangeMode = resolvedCountMode === sectionQuestionCountModes.RANGE;

        rowElement.innerHTML =
        `
            <div class="mock-test-marking-section-row-head">
                <input type="text" class="mock-test-marking-section-name-input" placeholder="Section name (e.g. Unit 1, Section B Numerical)" value="${MockTestSectionStructureFields.#escapeHtml(sectionEntry.name || "")}">
                <button type="button" class="mock-test-marking-section-remove-button" title="Remove this section">&times;</button>
            </div>

            <div class="mock-test-section-group">
                <div class="mock-test-section-group-title">
                    <span>Question types</span>
                    <settings-info-button topic="sectionQuestionTypes"></settings-info-button>
                    <span class="mock-test-section-group-note">Tick none to allow any type</span>
                </div>
                <div class="mock-test-marking-section-row-types">
                    ${typeCheckboxesHtml}
                </div>
            </div>

            <div class="mock-test-section-group mock-test-section-group-questions" ${bIsMarksRangeMode ? "hidden" : ""}>
                <div class="mock-test-section-group-title">
                    <span>Questions</span>
                    <settings-info-button topic="sectionQuestionCount"></settings-info-button>
                </div>
                <div class="mock-test-section-field-grid">
                    <label class="mock-test-section-field">
                        <span>How many</span>
                        <select class="mock-test-section-count-mode-select">
                            <option value="${sectionQuestionCountModes.FIXED}"${bIsCountRangeMode ? "" : " selected"}>Exactly</option>
                            <option value="${sectionQuestionCountModes.RANGE}"${bIsCountRangeMode ? " selected" : ""}>Between</option>
                        </select>
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-fixed-count" ${bIsCountRangeMode ? "hidden" : ""}>
                        <span>Questions</span>
                        <input type="number" min="1" step="1" class="mock-test-section-question-count-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCount)}">
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-range-count" ${bIsCountRangeMode ? "" : "hidden"}>
                        <span>Fewest</span>
                        <input type="number" min="1" step="1" class="mock-test-section-question-count-min-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCountMin)}">
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-range-count" ${bIsCountRangeMode ? "" : "hidden"}>
                        <span>Most</span>
                        <input type="number" min="1" step="1" class="mock-test-section-question-count-max-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCountMax)}">
                    </label>
                </div>
            </div>

            <div class="mock-test-section-group">
                <div class="mock-test-section-group-title">
                    <span>Marks</span>
                    <settings-info-button topic="sectionMarksMode"></settings-info-button>
                </div>
                <div class="mock-test-section-field-grid">
                    <label class="mock-test-section-field mock-test-section-field-wide">
                        <span>Each question is worth</span>
                        <select class="mock-test-section-marks-mode-select">
                            <option value="${sectionMarksModes.UNIFORM_PER_QUESTION}"${bIsMarksRangeMode ? "" : " selected"}>The same marks</option>
                            <option value="${sectionMarksModes.RANGE_PER_QUESTION}"${bIsMarksRangeMode ? " selected" : ""}>A range of marks</option>
                        </select>
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-uniform-marks" ${bIsMarksRangeMode ? "hidden" : ""}>
                        <span>Marks each</span>
                        <input type="number" min="0" step="0.01" class="mock-test-section-marks-per-question-input" value="${MockTestSectionStructureFields.#numberToInputValue(resolvedMarksPerQuestion)}">
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-range-marks" ${bIsMarksRangeMode ? "" : "hidden"}>
                        <span>Least marks</span>
                        <input type="number" min="0" step="0.01" class="mock-test-section-marks-per-question-min-input" value="${MockTestSectionStructureFields.#numberToInputValue(marksBand.minimum)}">
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-range-marks" ${bIsMarksRangeMode ? "" : "hidden"}>
                        <span>Most marks</span>
                        <input type="number" min="0" step="0.01" class="mock-test-section-marks-per-question-max-input" value="${MockTestSectionStructureFields.#numberToInputValue(marksBand.maximum)}">
                    </label>
                    <label class="mock-test-section-field mock-test-section-field-total-marks" ${bIsMarksRangeMode ? "" : "hidden"}>
                        <span>Section total</span>
                        <input type="number" min="0" step="0.01" class="mock-test-section-total-marks-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.totalMarks)}">
                    </label>
                </div>
                <div class="mock-test-section-derived-line" aria-live="polite"></div>
            </div>

            <div class="mock-test-section-group">
                <div class="mock-test-section-group-title">
                    <span>Scoring override</span>
                    <settings-info-button topic="sectionScoringOverride"></settings-info-button>
                    <span class="mock-test-section-group-note">Leave blank to use the paper default</span>
                </div>
                <div class="mock-test-marking-section-row-rule">
                    <label class="mock-test-section-field">
                        <span>Correct</span>
                        <input type="number" step="0.01" class="mock-test-marking-section-correct-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.correctMarks)}">
                    </label>
                    <label class="mock-test-section-field">
                        <span>Wrong</span>
                        <input type="number" step="0.01" class="mock-test-marking-section-wrong-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.wrongMarks)}">
                    </label>
                    <label class="mock-test-section-field">
                        <span>Unattempted</span>
                        <input type="number" step="0.01" class="mock-test-marking-section-unattempted-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.unattemptedMarks)}">
                    </label>
                    <label class="mock-test-section-field">
                        <span>Partial</span>
                        <input type="number" step="0.01" class="mock-test-marking-section-partial-input" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.partialMarks)}">
                    </label>
                </div>
            </div>
        `;

        const nameInput = rowElement.querySelector(".mock-test-marking-section-name-input");
        const removeButton = rowElement.querySelector(".mock-test-marking-section-remove-button");
        const typeCheckboxes = Array.from(rowElement.querySelectorAll(".mock-test-marking-section-row-types input[type='checkbox']"));
        const questionsGroup = rowElement.querySelector(".mock-test-section-group-questions");
        const countModeSelect = rowElement.querySelector(".mock-test-section-count-mode-select");
        const fixedCountField = rowElement.querySelector(".mock-test-section-field-fixed-count");
        const rangeCountFields = Array.from(rowElement.querySelectorAll(".mock-test-section-field-range-count"));
        const questionCountInput = rowElement.querySelector(".mock-test-section-question-count-input");
        const questionCountMinInput = rowElement.querySelector(".mock-test-section-question-count-min-input");
        const questionCountMaxInput = rowElement.querySelector(".mock-test-section-question-count-max-input");
        const marksModeSelect = rowElement.querySelector(".mock-test-section-marks-mode-select");
        const uniformMarksField = rowElement.querySelector(".mock-test-section-field-uniform-marks");
        const rangeMarksFields = Array.from(rowElement.querySelectorAll(".mock-test-section-field-range-marks"));
        const totalMarksField = rowElement.querySelector(".mock-test-section-field-total-marks");
        const marksPerQuestionInput = rowElement.querySelector(".mock-test-section-marks-per-question-input");
        const marksPerQuestionMinInput = rowElement.querySelector(".mock-test-section-marks-per-question-min-input");
        const marksPerQuestionMaxInput = rowElement.querySelector(".mock-test-section-marks-per-question-max-input");
        const totalMarksInput = rowElement.querySelector(".mock-test-section-total-marks-input");
        const derivedLine = rowElement.querySelector(".mock-test-section-derived-line");
        const correctInput = rowElement.querySelector(".mock-test-marking-section-correct-input");
        const wrongInput = rowElement.querySelector(".mock-test-marking-section-wrong-input");
        const unattemptedInput = rowElement.querySelector(".mock-test-marking-section-unattempted-input");
        const partialInput = rowElement.querySelector(".mock-test-marking-section-partial-input");

        // Sampling weights are no longer editable — the disclosure panel that
        // exposed them rendered empty for most of its life and asked users to
        // reason about something they had no way to judge. Templates that seed
        // them still work: the loaded value is carried through every write so
        // the assembler keeps sampling exactly as the template intended.
        const seededQuestionCountWeights = MockTestSectionStructureFields.#cloneWeights(sectionEntry.questionCountWeights);

        const applyModeVisibility = () =>
        {
            const bMarksRangeSelected = parseInt(marksModeSelect.value, 10) === sectionMarksModes.RANGE_PER_QUESTION;
            const bCountRangeSelected = parseInt(countModeSelect.value, 10) === sectionQuestionCountModes.RANGE;

            // In a marks-driven section the question count is not a setting at
            // all — it is an outcome — so the entire group goes away rather
            // than sitting there disabled and inviting clicks.
            questionsGroup.hidden = bMarksRangeSelected;
            fixedCountField.hidden = bCountRangeSelected;
            for (const rangeCountField of rangeCountFields)
            {
                rangeCountField.hidden = !bCountRangeSelected;
            }

            uniformMarksField.hidden = bMarksRangeSelected;
            for (const rangeMarksField of rangeMarksFields)
            {
                rangeMarksField.hidden = !bMarksRangeSelected;
            }
            totalMarksField.hidden = !bMarksRangeSelected;
        };

        const updateDerivedLine = () =>
        {
            const currentEntry = this.#readSectionEntryFromRow(rowElement, seededQuestionCountWeights);
            derivedLine.textContent = MockTestSectionStructureFields.#describeDerivedGeometry(
                currentEntry,
                this.#resolveDefaultMarksPerQuestion()
            );
        };

        const writeBack = () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const previousSections = [...(this.#settings.getSectionStructure() || [])];
            if (sectionIndex >= previousSections.length)
            {
                return;
            }

            previousSections[sectionIndex] = this.#readSectionEntryFromRow(rowElement, seededQuestionCountWeights);
            this.#settings.setSectionStructure(previousSections);

            updateDerivedLine();
            this.#updateSectionSummary();
            this.#notifyStructureChanged();
        };

        countModeSelect.addEventListener("change", () =>
        {
            applyModeVisibility();
            writeBack();
        });

        marksModeSelect.addEventListener("change", () =>
        {
            applyModeVisibility();
            writeBack();
        });

        nameInput.addEventListener("input", writeBack);
        for (const checkbox of typeCheckboxes)
        {
            checkbox.addEventListener("change", writeBack);
        }
        questionCountInput.addEventListener("input", writeBack);
        questionCountMinInput.addEventListener("input", writeBack);
        questionCountMaxInput.addEventListener("input", writeBack);
        marksPerQuestionInput.addEventListener("input", writeBack);
        marksPerQuestionMinInput.addEventListener("input", writeBack);
        marksPerQuestionMaxInput.addEventListener("input", writeBack);
        totalMarksInput.addEventListener("input", writeBack);
        correctInput.addEventListener("input", writeBack);
        wrongInput.addEventListener("input", writeBack);
        unattemptedInput.addEventListener("input", writeBack);
        partialInput.addEventListener("input", writeBack);

        removeButton.addEventListener("click", () =>
        {
            if (!this.#settings)
            {
                return;
            }
            const previousSections = [...(this.#settings.getSectionStructure() || [])];
            previousSections.splice(sectionIndex, 1);
            this.#settings.setSectionStructure(previousSections);
            this.#renderSectionRows();
            this.#updateSectionSummary();
            this.#notifyStructureChanged();
        });

        applyModeVisibility();
        updateDerivedLine();

        return rowElement;
    }

    /**
     * Reads a section card's DOM back into a settings entry.
     *
     * Only the fields that belong to the selected modes are emitted, so an
     * entry never carries a stale count from before the user switched to a
     * marks budget — a leftover key would be read as authoritative by the
     * assembler, which cannot see which controls were on screen.
     */
    #readSectionEntryFromRow(rowElement, seededQuestionCountWeights)
    {
        const selectedCountMode = parseInt(rowElement.querySelector(".mock-test-section-count-mode-select").value, 10);
        const selectedMarksMode = parseInt(rowElement.querySelector(".mock-test-section-marks-mode-select").value, 10);
        const bIsMarksRangeMode = selectedMarksMode === sectionMarksModes.RANGE_PER_QUESTION;
        const bIsCountRangeMode = selectedCountMode === sectionQuestionCountModes.RANGE;

        const updatedEntry = {
            name: rowElement.querySelector(".mock-test-marking-section-name-input").value,
            questionTypes: Array.from(rowElement.querySelectorAll(".mock-test-marking-section-row-types input[type='checkbox']"))
                .filter(checkbox => checkbox.checked)
                .map(checkbox => checkbox.value),
            marksMode: selectedMarksMode
        };

        if (bIsMarksRangeMode)
        {
            updatedEntry.marksPerQuestionMin = MockTestSectionStructureFields.#parseFloatOrDefault(rowElement.querySelector(".mock-test-section-marks-per-question-min-input").value, 0);
            updatedEntry.marksPerQuestionMax = MockTestSectionStructureFields.#parseFloatOrDefault(rowElement.querySelector(".mock-test-section-marks-per-question-max-input").value, 0);
            updatedEntry.totalMarks = MockTestSectionStructureFields.#parseFloatOrDefault(rowElement.querySelector(".mock-test-section-total-marks-input").value, 0);

            // The count band falls out of the budget, but the assembler and the
            // scoring engine both read questionCountMode, so it is stamped to
            // RANGE to describe what will actually happen.
            updatedEntry.questionCountMode = sectionQuestionCountModes.RANGE;
            const derivedCountBand = MockTestSectionGeometry.resolveQuestionCountBand(updatedEntry);
            updatedEntry.questionCountMin = derivedCountBand.minimum;
            updatedEntry.questionCountMax = derivedCountBand.maximum;
        }
        else
        {
            const marksPerQuestion = MockTestSectionStructureFields.#parseFloatOrDefault(rowElement.querySelector(".mock-test-section-marks-per-question-input").value, 0);
            updatedEntry.marksPerQuestion = marksPerQuestion;
            updatedEntry.questionCountMode = selectedCountMode;

            if (bIsCountRangeMode)
            {
                updatedEntry.questionCountMin = MockTestSectionStructureFields.#parseIntOrZero(rowElement.querySelector(".mock-test-section-question-count-min-input").value);
                updatedEntry.questionCountMax = MockTestSectionStructureFields.#parseIntOrZero(rowElement.querySelector(".mock-test-section-question-count-max-input").value);

                if (Object.keys(seededQuestionCountWeights).length > 0)
                {
                    updatedEntry.questionCountWeights = MockTestSectionStructureFields.#cloneWeights(seededQuestionCountWeights);
                }
            }
            else
            {
                updatedEntry.questionCount = MockTestSectionStructureFields.#parseIntOrZero(rowElement.querySelector(".mock-test-section-question-count-input").value);
            }

            const countBand = MockTestSectionGeometry.resolveQuestionCountBand(updatedEntry);
            updatedEntry.totalMarks = countBand.maximum * marksPerQuestion;
        }

        MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "correctMarks", rowElement.querySelector(".mock-test-marking-section-correct-input").value);
        MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "wrongMarks", rowElement.querySelector(".mock-test-marking-section-wrong-input").value);
        MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "unattemptedMarks", rowElement.querySelector(".mock-test-marking-section-unattempted-input").value);
        MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "partialMarks", rowElement.querySelector(".mock-test-marking-section-partial-input").value);

        return updatedEntry;
    }

    /**
     * The one-line "here is what that adds up to" under a section's marks
     * group. It reports whichever quantity the user did NOT enter, which is the
     * whole point of the two-of-three model — and says so plainly when the
     * numbers cannot work out.
     */
    static #describeDerivedGeometry(sectionEntry, fallbackMarksPerQuestion)
    {
        if (MockTestSectionGeometry.resolveMarksMode(sectionEntry) === sectionMarksModes.RANGE_PER_QUESTION)
        {
            const marksBand = MockTestSectionGeometry.resolveMarksPerQuestionBand(sectionEntry);
            const totalMarksBudget = MockTestSectionGeometry.resolveTotalMarksBudget(sectionEntry);

            if (marksBand.minimum <= 0 || totalMarksBudget <= 0)
            {
                return "Set the marks range and the section total to see how many questions that takes.";
            }

            const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
            if (countBand.minimum <= 0)
            {
                return `${MockTestSectionStructureFields.#formatMarks(totalMarksBudget)} marks cannot be split into questions worth `
                    + `${MockTestSectionStructureFields.#formatMarks(marksBand.minimum)}-${MockTestSectionStructureFields.#formatMarks(marksBand.maximum)} marks each.`;
            }

            const countDescription = countBand.minimum === countBand.maximum
                ? `${countBand.minimum} question(s)`
                : `${countBand.minimum}-${countBand.maximum} questions`;

            return `Works out to ${countDescription}, each worth `
                + `${MockTestSectionStructureFields.#formatMarks(marksBand.minimum)}-${MockTestSectionStructureFields.#formatMarks(marksBand.maximum)} marks, `
                + `totalling ${MockTestSectionStructureFields.#formatMarks(totalMarksBudget)}.`;
        }

        const marksPerQuestion = MockTestSectionGeometry.resolveMarksPerQuestion(sectionEntry, fallbackMarksPerQuestion);
        const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);

        if (marksPerQuestion <= 0 || countBand.maximum <= 0)
        {
            return "Set the question count and the marks each to see the section total.";
        }

        const marksBand = MockTestSectionGeometry.resolveTotalMarksBand(sectionEntry, fallbackMarksPerQuestion);
        if (marksBand.minimum === marksBand.maximum)
        {
            return `Section total: ${MockTestSectionStructureFields.#formatMarks(marksBand.maximum)} marks `
                + `(${countBand.maximum} x ${MockTestSectionStructureFields.#formatMarks(marksPerQuestion)}).`;
        }

        return `Section total: ${MockTestSectionStructureFields.#formatMarks(marksBand.minimum)}-${MockTestSectionStructureFields.#formatMarks(marksBand.maximum)} marks `
            + `(${countBand.minimum}-${countBand.maximum} questions x ${MockTestSectionStructureFields.#formatMarks(marksPerQuestion)}).`;
    }

    #updateSectionSummary()
    {
        const summaryElement = this.querySelector(".mock-test-section-structure-summary");
        if (!summaryElement || !this.#settings)
        {
            return;
        }

        const sections = this.#settings.getSectionStructure() || [];
        if (sections.length === 0)
        {
            summaryElement.textContent = "";
            summaryElement.classList.remove("mock-test-section-structure-summary-mismatch");
            return;
        }

        const countBand = MockTestSectionGeometry.resolveStructureQuestionCountBand(sections);
        const marksBand = MockTestSectionGeometry.resolveStructureTotalMarksBand(sections, this.#resolveDefaultMarksPerQuestion());

        const countDescription = countBand.minimum === countBand.maximum
            ? `${countBand.maximum}`
            : `${countBand.minimum}-${countBand.maximum}`;
        const marksDescription = marksBand.minimum === marksBand.maximum
            ? MockTestSectionStructureFields.#formatMarks(marksBand.maximum)
            : `${MockTestSectionStructureFields.#formatMarks(marksBand.minimum)}-${MockTestSectionStructureFields.#formatMarks(marksBand.maximum)}`;

        let summaryText = `${sections.length} section(s) · ${countDescription} question(s) · ${marksDescription} marks`;

        const validationFailure = this.getValidationFailure();
        const bIsMismatch = validationFailure !== null;

        if (bIsMismatch)
        {
            summaryText += `  —  ${validationFailure}`;
        }

        summaryElement.textContent = summaryText;
        summaryElement.classList.toggle("mock-test-section-structure-summary-mismatch", bIsMismatch);
    }

    static #cloneWeights(rawWeights)
    {
        const clonedWeights = {};
        if (rawWeights && typeof rawWeights === "object")
        {
            for (const weightKey of Object.keys(rawWeights))
            {
                const weightValue = rawWeights[weightKey];
                if (typeof weightValue === "number" && Number.isFinite(weightValue))
                {
                    clonedWeights[String(weightKey)] = weightValue;
                }
            }
        }
        return clonedWeights;
    }

    static #findFirstUnusedTypeKey(currentOverrides)
    {
        for (const typeKey of Object.keys(questionTypes))
        {
            if (!(typeKey in currentOverrides))
            {
                return typeKey;
            }
        }
        return null;
    }

    static #parseFloatOrDefault(rawValue, defaultValue)
    {
        const parsed = parseFloat(rawValue);
        return Number.isFinite(parsed) ? parsed : defaultValue;
    }

    static #parseIntOrZero(rawValue)
    {
        const parsed = parseInt(rawValue, 10);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }

    static #assignFloatIfPresent(targetObject, fieldName, rawValue)
    {
        if (rawValue === "" || rawValue === null || rawValue === undefined)
        {
            return;
        }
        const parsed = parseFloat(rawValue);
        if (Number.isFinite(parsed))
        {
            targetObject[fieldName] = parsed;
        }
    }

    static #numberToInputValue(value)
    {
        if (typeof value !== "number" || !Number.isFinite(value))
        {
            return "";
        }
        // Back-derived marks land on values like 3.9999999999999996; the inputs
        // step in hundredths, so anything finer is display noise.
        return String(Math.round(value * 100) / 100);
    }

    static #formatMarks(value)
    {
        if (!Number.isFinite(value))
        {
            return "0";
        }
        if (Number.isInteger(value))
        {
            return String(value);
        }
        return String(Math.round(value * 100) / 100);
    }

    static #escapeHtml(rawString)
    {
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define(MockTestSectionStructureFields.tagName, MockTestSectionStructureFields);
export default MockTestSectionStructureFields;
