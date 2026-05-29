import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { sectionQuestionCountModes } from "../../../Globals/Enumerations/SectionQuestionCountModes.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";


/**
 * MockTestSectionStructureFields
 *
 * Unified editor for a mock test's structural + scoring layout:
 *
 *   1. Paper-default marking rule       (correct / wrong / unattempted / partial)
 *   2. Per-question-type marking overrides (optional)
 *   3. Section structure                 (ordered list of sections — each carries
 *                                         name, question types, question count,
 *                                         total marks, optional marking-rule
 *                                         overrides)
 *
 * Sections are the primary structural concept for templated papers: JEE
 * Advanced's three sections, GATE's 1-mark/2-mark tiers, CBSE's mark-band
 * sections, Engineering papers' unit-based sections. The section list is
 * always visible (no longer collapsed behind an "advanced" toggle) — every
 * exam-prep template seeds it, and the user is expected to configure it
 * directly for custom papers.
 *
 * Blank number inputs are treated as "inherit from parent tier" — the
 * corresponding marking-rule key is omitted from the override entry so a
 * future scoring engine resolves it via the lookup hierarchy.
 *
 * The component is bound to a MockTestGenerationSettings instance via
 * setSettings(). Every change in the DOM writes back through the settings
 * setters; template-driven changes call rebuildFromSettings() to pull
 * fresh values into the DOM.
 */
class MockTestSectionStructureFields extends HTMLElement
{
    static tagName = "mock-test-section-structure-fields";

    static SECTION_HELP_TEXT = "Sections control how questions are grouped, counted, and scored. Templates pre-fill these for known exams; customize freely for your own paper layout.";

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
                    <div class="mock-test-marking-subgroup-title">Section structure</div>
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
            sections.push({
                name: "",
                questionTypes: [],
                questionCountMode: sectionQuestionCountModes.FIXED,
                questionCount: 0,
                totalMarks: 0
            });
            this.#settings.setSectionStructure(sections);
            this.#renderSectionRows();
            this.#updateSectionSummary();
        });
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
            <input type="number" step="0.01" class="mock-test-marking-override-correct-input" placeholder="correct" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.correctMarks)}">
            <input type="number" step="0.01" class="mock-test-marking-override-wrong-input" placeholder="wrong" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.wrongMarks)}">
            <input type="number" step="0.01" class="mock-test-marking-override-unattempted-input" placeholder="unattempted" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.unattemptedMarks)}">
            <input type="number" step="0.01" class="mock-test-marking-override-partial-input" placeholder="partial" value="${MockTestSectionStructureFields.#numberToInputValue(ruleOverride.partialMarks)}">
            <button type="button" class="mock-test-marking-override-remove-button" title="Remove">×</button>
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
                const isChecked = currentTypeKeys.includes(typeKey);
                return `
                    <label class="mock-test-marking-section-type-checkbox">
                        <input type="checkbox" value="${typeKey}"${isChecked ? " checked" : ""}>
                        ${enumerationToTitleCase(typeKey)}
                    </label>
                `;
            })
            .join("");

        const resolvedMode = MockTestSectionStructureFields.#resolveModeValue(sectionEntry);
        const isRangeMode = resolvedMode === sectionQuestionCountModes.RANGE;

        rowElement.innerHTML =
        `
            <div class="mock-test-marking-section-row-head">
                <input type="text" class="mock-test-marking-section-name-input" placeholder="Section name (e.g. Unit 1, Section B Numerical)" value="${MockTestSectionStructureFields.#escapeHtml(sectionEntry.name || "")}">
                <button type="button" class="mock-test-marking-section-remove-button" title="Remove">×</button>
            </div>
            <div class="mock-test-marking-section-row-types">
                ${typeCheckboxesHtml}
            </div>
            <div class="mock-test-section-row-counts">
                <label class="mock-test-section-row-count-label">
                    <span>Mode</span>
                    <select class="mock-test-section-mode-select">
                        <option value="${sectionQuestionCountModes.FIXED}"${resolvedMode === sectionQuestionCountModes.FIXED ? " selected" : ""}>Fixed</option>
                        <option value="${sectionQuestionCountModes.RANGE}"${resolvedMode === sectionQuestionCountModes.RANGE ? " selected" : ""}>Range</option>
                    </select>
                </label>
                <label class="mock-test-section-row-count-label">
                    <span>Total marks</span>
                    <input type="number" min="0" step="0.01" class="mock-test-section-total-marks-input" placeholder="marks" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.totalMarks)}">
                </label>
            </div>
            <div class="mock-test-section-row-fixed-count" ${isRangeMode ? "hidden" : ""}>
                <label class="mock-test-section-row-count-label">
                    <span>Questions</span>
                    <input type="number" min="0" step="1" class="mock-test-section-question-count-input" placeholder="count" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCount)}">
                </label>
            </div>
            <div class="mock-test-section-row-range" ${isRangeMode ? "" : "hidden"}>
                <div class="mock-test-section-row-range-bounds">
                    <label class="mock-test-section-row-count-label">
                        <span>Min</span>
                        <input type="number" min="0" step="1" class="mock-test-section-question-count-min-input" placeholder="min" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCountMin)}">
                    </label>
                    <label class="mock-test-section-row-count-label">
                        <span>Max</span>
                        <input type="number" min="0" step="1" class="mock-test-section-question-count-max-input" placeholder="max" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.questionCountMax)}">
                    </label>
                </div>
                <details class="mock-test-section-row-weights-panel">
                    <summary>Weights (advanced)</summary>
                    <div class="mock-test-section-row-weights-grid"></div>
                </details>
            </div>
            <div class="mock-test-marking-section-row-rule">
                <input type="number" step="0.01" class="mock-test-marking-section-correct-input" placeholder="correct" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.correctMarks)}">
                <input type="number" step="0.01" class="mock-test-marking-section-wrong-input" placeholder="wrong" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.wrongMarks)}">
                <input type="number" step="0.01" class="mock-test-marking-section-unattempted-input" placeholder="unattempted" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.unattemptedMarks)}">
                <input type="number" step="0.01" class="mock-test-marking-section-partial-input" placeholder="partial" value="${MockTestSectionStructureFields.#numberToInputValue(sectionEntry.partialMarks)}">
            </div>
        `;

        const nameInput = rowElement.querySelector(".mock-test-marking-section-name-input");
        const removeButton = rowElement.querySelector(".mock-test-marking-section-remove-button");
        const typeCheckboxes = Array.from(rowElement.querySelectorAll(".mock-test-marking-section-row-types input[type='checkbox']"));
        const modeSelect = rowElement.querySelector(".mock-test-section-mode-select");
        const fixedCountWrapper = rowElement.querySelector(".mock-test-section-row-fixed-count");
        const rangeWrapper = rowElement.querySelector(".mock-test-section-row-range");
        const questionCountInput = rowElement.querySelector(".mock-test-section-question-count-input");
        const questionCountMinInput = rowElement.querySelector(".mock-test-section-question-count-min-input");
        const questionCountMaxInput = rowElement.querySelector(".mock-test-section-question-count-max-input");
        const weightsGrid = rowElement.querySelector(".mock-test-section-row-weights-grid");
        const totalMarksInput = rowElement.querySelector(".mock-test-section-total-marks-input");
        const correctInput = rowElement.querySelector(".mock-test-marking-section-correct-input");
        const wrongInput = rowElement.querySelector(".mock-test-marking-section-wrong-input");
        const unattemptedInput = rowElement.querySelector(".mock-test-marking-section-unattempted-input");
        const partialInput = rowElement.querySelector(".mock-test-marking-section-partial-input");

        let currentWeights = MockTestSectionStructureFields.#cloneWeights(sectionEntry.questionCountWeights);

        const renderWeightsGrid = () =>
        {
            const minimumCount = MockTestSectionStructureFields.#parseIntOrZero(questionCountMinInput.value);
            const maximumCount = MockTestSectionStructureFields.#parseIntOrZero(questionCountMaxInput.value);

            weightsGrid.innerHTML = "";

            if (maximumCount < minimumCount)
            {
                return;
            }

            for (let candidateValue = minimumCount; candidateValue <= maximumCount; candidateValue++)
            {
                const existingWeight = currentWeights[String(candidateValue)];
                const weightToShow = (typeof existingWeight === "number" && Number.isFinite(existingWeight)) ? existingWeight : 1;

                const cellElement = document.createElement("label");
                cellElement.className = "mock-test-section-row-weight-cell";
                cellElement.innerHTML =
                `
                    <span>${candidateValue}</span>
                    <input type="number" min="0" step="0.1" class="mock-test-section-row-weight-input" data-candidate-value="${candidateValue}" value="${weightToShow}">
                `;
                weightsGrid.appendChild(cellElement);
            }

            for (const weightInput of weightsGrid.querySelectorAll(".mock-test-section-row-weight-input"))
            {
                weightInput.addEventListener("input", () =>
                {
                    const candidateValue = weightInput.dataset.candidateValue;
                    const parsedWeight = parseFloat(weightInput.value);
                    if (Number.isFinite(parsedWeight) && parsedWeight >= 0)
                    {
                        currentWeights[candidateValue] = parsedWeight;
                    }
                    else
                    {
                        delete currentWeights[candidateValue];
                    }
                    writeBack();
                });
            }
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

            const selectedMode = parseInt(modeSelect.value, 10);
            const isInRangeMode = selectedMode === sectionQuestionCountModes.RANGE;

            const updatedEntry = {
                name: nameInput.value,
                questionTypes: typeCheckboxes.filter(checkbox => checkbox.checked).map(checkbox => checkbox.value),
                questionCountMode: selectedMode,
                totalMarks: MockTestSectionStructureFields.#parseFloatOrDefault(totalMarksInput.value, 0)
            };

            if (isInRangeMode)
            {
                updatedEntry.questionCountMin = MockTestSectionStructureFields.#parseIntOrZero(questionCountMinInput.value);
                updatedEntry.questionCountMax = MockTestSectionStructureFields.#parseIntOrZero(questionCountMaxInput.value);
                updatedEntry.questionCountWeights = MockTestSectionStructureFields.#cloneWeights(currentWeights);
            }
            else
            {
                updatedEntry.questionCount = MockTestSectionStructureFields.#parseIntOrZero(questionCountInput.value);
            }

            MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "correctMarks", correctInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "wrongMarks", wrongInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "unattemptedMarks", unattemptedInput.value);
            MockTestSectionStructureFields.#assignFloatIfPresent(updatedEntry, "partialMarks", partialInput.value);

            previousSections[sectionIndex] = updatedEntry;
            this.#settings.setSectionStructure(previousSections);
            this.#updateSectionSummary();
        };

        modeSelect.addEventListener("change", () =>
        {
            const selectedMode = parseInt(modeSelect.value, 10);
            const isInRangeMode = selectedMode === sectionQuestionCountModes.RANGE;
            fixedCountWrapper.hidden = isInRangeMode;
            rangeWrapper.hidden = !isInRangeMode;
            if (isInRangeMode)
            {
                renderWeightsGrid();
            }
            writeBack();
        });

        nameInput.addEventListener("input", writeBack);
        for (const checkbox of typeCheckboxes)
        {
            checkbox.addEventListener("change", writeBack);
        }
        questionCountInput.addEventListener("input", writeBack);
        questionCountMinInput.addEventListener("input", () =>
        {
            renderWeightsGrid();
            writeBack();
        });
        questionCountMaxInput.addEventListener("input", () =>
        {
            renderWeightsGrid();
            writeBack();
        });
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
        });

        if (isRangeMode)
        {
            renderWeightsGrid();
        }

        return rowElement;
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

        const totalQuestionsAcrossSections = sections.reduce(
            (sum, entry) => sum + MockTestSectionStructureFields.#resolveExpectedQuestionCount(entry),
            0
        );
        const totalMarksAcrossSections = sections.reduce(
            (sum, entry) => sum + (Number.isFinite(entry?.totalMarks) ? entry.totalMarks : 0),
            0
        );

        const paperQuestionTarget = Number.isFinite(this.#settings.getNumQuestionsPerTest?.())
            ? this.#settings.getNumQuestionsPerTest()
            : null;

        let summaryText = `Total: ${totalQuestionsAcrossSections}`;
        let bIsMismatch = false;
        if (paperQuestionTarget !== null && paperQuestionTarget > 0)
        {
            summaryText += ` / ${paperQuestionTarget} questions`;
            bIsMismatch = totalQuestionsAcrossSections !== paperQuestionTarget;
        }
        else
        {
            summaryText += ` question(s)`;
        }
        summaryText += ` · ${MockTestSectionStructureFields.#formatMarks(totalMarksAcrossSections)} marks across all sections`;

        if (bIsMismatch)
        {
            summaryText += `  —  sections don't sum to paper total (paper questions setting is ${paperQuestionTarget})`;
        }

        summaryElement.textContent = summaryText;
        summaryElement.classList.toggle("mock-test-section-structure-summary-mismatch", bIsMismatch);
    }

    static #resolveModeValue(sectionEntry)
    {
        if (sectionEntry?.questionCountMode === sectionQuestionCountModes.RANGE)
        {
            return sectionQuestionCountModes.RANGE;
        }
        return sectionQuestionCountModes.FIXED;
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

    static #resolveExpectedQuestionCount(sectionEntry)
    {
        if (!sectionEntry)
        {
            return 0;
        }

        if (sectionEntry.questionCountMode === sectionQuestionCountModes.RANGE)
        {
            const minimumCount = Number.isFinite(sectionEntry.questionCountMin) ? sectionEntry.questionCountMin : 0;
            const maximumCount = Number.isFinite(sectionEntry.questionCountMax) ? sectionEntry.questionCountMax : minimumCount;
            if (maximumCount < minimumCount)
            {
                return 0;
            }

            const configuredWeights = sectionEntry.questionCountWeights || {};
            let weightedTotal = 0;
            let weightSum = 0;
            for (let candidateValue = minimumCount; candidateValue <= maximumCount; candidateValue++)
            {
                const rawWeight = configuredWeights[String(candidateValue)];
                const candidateWeight = (typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0) ? rawWeight : 1;
                weightedTotal += candidateValue * candidateWeight;
                weightSum += candidateWeight;
            }
            if (weightSum === 0)
            {
                return Math.round((minimumCount + maximumCount) / 2);
            }
            return Math.round(weightedTotal / weightSum);
        }

        return Number.isFinite(sectionEntry.questionCount) ? sectionEntry.questionCount : 0;
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
        return typeof value === "number" && Number.isFinite(value) && value !== 0 ? String(value) : (value === 0 ? "0" : "");
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
        return value.toFixed(2);
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
