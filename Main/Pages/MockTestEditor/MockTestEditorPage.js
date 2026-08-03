import { mockTestItemTypes } from "../../Globals/Enumerations/MockTestItemTypes.js";
import { questionTypes } from "../../Globals/Enumerations/QuestionTypes.js";
import { getRandomUuid } from "../../Globals/UtilityFunctions/GetRandomUuid.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import Lifecycle from "../../Globals/Model/Lifecycle.js";
import MockTest from "../../Globals/Model/MockTest.js";
import MockTestItemFactory from "../../Globals/Model/MockTestEntities/MockTestItemFactory.js";
import MockTestQuestion from "../../Globals/Model/MockTestEntities/MockTestQuestion.js";
import MockTestSection from "../../Globals/Model/MockTestEntities/MockTestSection.js";
import MockTestTitle from "../../Globals/Model/MockTestEntities/MockTestTitle.js";
import MockTestInstructions from "../../Globals/Model/MockTestEntities/MockTestInstructions.js";
import MockTestStartDialog from "../Study/Components/MockTestStartDialog.js";
import RichTextEditor from "../CardEditor/Components/RichTextEditor.js";

// Requires: Pages/MockTestEditor/Styles/MockTestEditorPage.css

/**
 * Sophisticated editor for a MockTest. Lets the user manage the title,
 * duration, marking scheme, and the heterogeneous items array (titles,
 * instructions, sections, questions) with full per-question editing
 * (question text, type, options, expected answer, reason, solving
 * steps, marks).
 *
 * Opened via PageNavigator.open("mock-test-editor-page", mockTestOrNull, deck).
 * Pass null as the first arg to create a new test for the given deck.
 *
 * Work is held entirely in a local draft (deep-clone of the existing
 * mock test, or a freshly built MockTest for new). Nothing is persisted
 * until Save is clicked.
 */
class MockTestEditorPage extends HTMLElement
{
    static QUESTION_TYPE_OPTIONS = [
        { value: questionTypes.MULTIPLE_CHOICE,                label: "Multiple Choice (Single Correct)" },
        { value: questionTypes.MULTIPLE_CORRECT,               label: "Multiple Correct" },
        { value: questionTypes.OBJECTIVE_SINGLE_WORD_OR_PHRASE, label: "Objective (Single Word / Phrase)" },
        { value: questionTypes.SHORT_SUBJECTIVE,               label: "Short Subjective" },
        { value: questionTypes.MEDIUM_SUBJECTIVE,              label: "Medium Subjective" },
        { value: questionTypes.LONG_SUBJECTIVE,                label: "Long Subjective" },
        { value: questionTypes.VERY_LONG_SUBJECTIVE,           label: "Very Long Subjective" }
    ];

    static ITEM_TYPE_PICKER_OPTIONS = [
        { value: mockTestItemTypes.QUESTION,     label: "Question" },
        { value: mockTestItemTypes.SECTION,      label: "Section" },
        { value: mockTestItemTypes.INSTRUCTIONS, label: "Instructions" },
        { value: mockTestItemTypes.TITLE,        label: "Title" }
    ];

    #originalMockTest = null;
    #deck = null;
    #bNewMockTest = false;

    // Draft state — never references the live mock test's items / scheme.
    #draftTitle = "";
    #draftDurationMinutes = 0;
    #draftMarkingScheme = null;
    #draftItems = [];

    initialize(mockTest, deck)
    {
        this.#deck = deck;

        if (!mockTest)
        {
            this.#originalMockTest = null;
            this.#bNewMockTest = true;
            this.#draftTitle = "New Mock Test";
            this.#draftDurationMinutes = 60;
            this.#draftMarkingScheme = { ...MockTest.DEFAULT_MARKING_SCHEME };
            this.#draftItems = [];
        }
        else
        {
            this.#originalMockTest = mockTest;
            this.#bNewMockTest = false;
            this.#draftTitle = mockTest.getTitle() || "";
            this.#draftDurationMinutes = mockTest.getDuration() || 0;
            this.#draftMarkingScheme = MockTestEditorPage.#cloneMarkingScheme(mockTest.getMarkingScheme());
            this.#draftItems = (mockTest.getItems() || []).map((sourceItem) => MockTestItemFactory.fromJson(sourceItem.toJson()));
        }
    }

    connectedCallback()
    {
        // Mock tests in a paid deck are still server-authored and immutable:
        // MockTest.setItems writes straight to the entity, and the server's
        // paid-content preserve step discards it on the next push — so the
        // editor would accept every change and silently lose it. Refuse to open
        // rather than lie, exactly as the card editor used to. (Cards and study
        // materials are editable now via encrypted overlays; extending overlays
        // to a mock test means one record per field per question, which is a
        // separate piece of work.)
        if (this.#deck?.getAdditionalData?.()?.paidDeckId)
        {
            this.innerHTML =
            `
                <header-component title="Read-only"></header-component>
                <p style="padding: 20px; text-align: center;">Mock tests in a purchased deck can't be edited.</p>
            `;
            return;
        }

        this.innerHTML = `
            <header-component title="${this.#bNewMockTest ? "New Mock Test" : "Edit Mock Test"}"></header-component>
            <div class="mock-test-editor-scrollable">
                <div class="mock-test-editor-content">

                    <section class="mock-test-editor-meta-section">
                        <div class="mock-test-editor-field">
                            <label class="mock-test-editor-label">Title</label>
                            <input
                                type="text"
                                class="mock-test-editor-title-input"
                                placeholder="Mock Test title"
                            />
                        </div>
                        <div class="mock-test-editor-field">
                            <label class="mock-test-editor-label">Duration (minutes)</label>
                            <input
                                type="number"
                                class="mock-test-editor-duration-input"
                                min="0"
                            />
                        </div>
                    </section>

                    <section class="mock-test-editor-marking-section">
                        <div class="mock-test-editor-section-header">Default Marking Scheme</div>
                        <div class="mock-test-editor-marking-grid">
                            <div class="mock-test-editor-field">
                                <label class="mock-test-editor-label">Correct</label>
                                <input type="number" step="any" class="mock-test-editor-marking-input" data-marking-field="correctMarks" />
                            </div>
                            <div class="mock-test-editor-field">
                                <label class="mock-test-editor-label">Wrong</label>
                                <input type="number" step="any" class="mock-test-editor-marking-input" data-marking-field="wrongMarks" />
                            </div>
                            <div class="mock-test-editor-field">
                                <label class="mock-test-editor-label">Unattempted</label>
                                <input type="number" step="any" class="mock-test-editor-marking-input" data-marking-field="unattemptedMarks" />
                            </div>
                            <div class="mock-test-editor-field">
                                <label class="mock-test-editor-label">Partial</label>
                                <input type="number" step="any" class="mock-test-editor-marking-input" data-marking-field="partialMarks" />
                            </div>
                        </div>
                    </section>

                    <section class="mock-test-editor-items-section">
                        <div class="mock-test-editor-section-header">Items</div>
                        <div class="mock-test-editor-items-container"></div>
                        <button class="mock-test-editor-add-item-button" type="button">+ Add Item</button>
                    </section>

                </div>
            </div>
            <div class="mock-test-editor-action-bar">
                <button class="mock-test-editor-cancel-button" type="button">Cancel</button>
                ${this.#bNewMockTest ? "" : `<button class="mock-test-editor-delete-button" type="button">Delete</button>`}
                <button class="mock-test-editor-preview-button" type="button">Preview</button>
                <button class="mock-test-editor-save-button" type="button">Save</button>
            </div>
        `;

        this.#populateMetaInputs();
        this.#renderItems();
        this.#bindMetaEvents();
        this.#bindActionBarEvents();
    }

    // ── Meta / marking inputs ──────────────────────────────────────────────────

    #populateMetaInputs()
    {
        const titleInput = this.querySelector(".mock-test-editor-title-input");
        const durationInput = this.querySelector(".mock-test-editor-duration-input");
        titleInput.value = this.#draftTitle;
        durationInput.value = String(this.#draftDurationMinutes);

        const markingInputs = this.querySelectorAll(".mock-test-editor-marking-input");
        for (const markingInput of markingInputs)
        {
            const fieldName = markingInput.dataset.markingField;
            markingInput.value = String(this.#draftMarkingScheme[fieldName] ?? 0);
        }
    }

    #bindMetaEvents()
    {
        const titleInput = this.querySelector(".mock-test-editor-title-input");
        titleInput.addEventListener("input", () =>
        {
            this.#draftTitle = titleInput.value;
        });

        const durationInput = this.querySelector(".mock-test-editor-duration-input");
        durationInput.addEventListener("input", () =>
        {
            const parsedValue = parseInt(durationInput.value, 10);
            this.#draftDurationMinutes = Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : 0;
        });

        const markingInputs = this.querySelectorAll(".mock-test-editor-marking-input");
        for (const markingInput of markingInputs)
        {
            markingInput.addEventListener("input", () =>
            {
                const fieldName = markingInput.dataset.markingField;
                const parsedValue = parseFloat(markingInput.value);
                this.#draftMarkingScheme[fieldName] = Number.isFinite(parsedValue) ? parsedValue : 0;
            });
        }
    }

    // ── Items rendering & wiring ───────────────────────────────────────────────

    #renderItems()
    {
        const itemsContainer = this.querySelector(".mock-test-editor-items-container");
        if (!itemsContainer)
        {
            return;
        }

        if (this.#draftItems.length === 0)
        {
            itemsContainer.innerHTML = `<div class="mock-test-editor-empty-items">No items yet — click "Add Item" below to start.</div>`;
            return;
        }

        let runningQuestionNumber = 0;
        const renderedFragments = [];

        for (let itemIndex = 0; itemIndex < this.#draftItems.length; itemIndex++)
        {
            const draftItem = this.#draftItems[itemIndex];
            const itemType = draftItem.getType();
            if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
            }
            renderedFragments.push(this.#renderItemEditor(draftItem, itemIndex, runningQuestionNumber));
        }

        itemsContainer.innerHTML = renderedFragments.join("");
        this.#bindItemEvents();
    }

    #renderItemEditor(draftItem, itemIndex, questionNumber)
    {
        const itemType = draftItem.getType();

        if (itemType === mockTestItemTypes.TITLE)
        {
            return this.#renderTitleItemEditor(draftItem, itemIndex);
        }
        if (itemType === mockTestItemTypes.INSTRUCTIONS)
        {
            return this.#renderInstructionsItemEditor(draftItem, itemIndex);
        }
        if (itemType === mockTestItemTypes.SECTION)
        {
            return this.#renderSectionItemEditor(draftItem, itemIndex);
        }
        if (itemType === mockTestItemTypes.QUESTION)
        {
            return this.#renderQuestionItemEditor(draftItem, itemIndex, questionNumber);
        }
        return "";
    }

    #renderItemCardShell(itemIndex, badgeLabel, innerHtml)
    {
        const isFirst = itemIndex === 0;
        const isLast = itemIndex === this.#draftItems.length - 1;
        return `
            <div class="mock-test-editor-item-card" data-item-index="${itemIndex}">
                <div class="mock-test-editor-item-header">
                    <span class="mock-test-editor-item-badge">${MockTestEditorPage.#escapeHtml(badgeLabel)}</span>
                    <div class="mock-test-editor-item-actions">
                        <button class="mock-test-editor-move-up-button" type="button" data-item-index="${itemIndex}" ${isFirst ? "disabled" : ""}>&uarr;</button>
                        <button class="mock-test-editor-move-down-button" type="button" data-item-index="${itemIndex}" ${isLast ? "disabled" : ""}>&darr;</button>
                        <button class="mock-test-editor-delete-item-button" type="button" data-item-index="${itemIndex}">&times;</button>
                    </div>
                </div>
                <div class="mock-test-editor-item-body">
                    ${innerHtml}
                </div>
            </div>
        `;
    }

    #renderTitleItemEditor(titleItem, itemIndex)
    {
        const titleValue = titleItem.getTitle() || "";
        return this.#renderItemCardShell(itemIndex, "TITLE", `
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Title text</label>
                <input
                    type="text"
                    class="mock-test-editor-title-item-input"
                    data-item-index="${itemIndex}"
                    value="${MockTestEditorPage.#escapeHtml(titleValue)}"
                />
            </div>
        `);
    }

    #renderInstructionsItemEditor(instructionsItem, itemIndex)
    {
        return this.#renderItemCardShell(itemIndex, "INSTRUCTIONS", `
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Content</label>
                <rich-text-editor
                    class="mock-test-editor-instructions-editor mock-test-editor-rich-text-editor"
                    data-item-index="${itemIndex}"
                    data-rich-text-field="instructionsContent"
                    placeholder="Instructions for this section..."
                ></rich-text-editor>
            </div>
        `);
    }

    #renderSectionItemEditor(sectionItem, itemIndex)
    {
        const titleValue = sectionItem.getTitle() || "";
        const descriptionValue = sectionItem.getDescription() || "";
        return this.#renderItemCardShell(itemIndex, "SECTION", `
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Section title</label>
                <input
                    type="text"
                    class="mock-test-editor-section-title-input"
                    data-item-index="${itemIndex}"
                    value="${MockTestEditorPage.#escapeHtml(titleValue)}"
                />
            </div>
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Section description</label>
                <input
                    type="text"
                    class="mock-test-editor-section-description-input"
                    data-item-index="${itemIndex}"
                    value="${MockTestEditorPage.#escapeHtml(descriptionValue)}"
                />
            </div>
        `);
    }

    #renderQuestionItemEditor(questionItem, itemIndex, questionNumber)
    {
        const additionalData = questionItem.getAdditionalData() || {};
        const resolvedType = Number.isFinite(additionalData.type) ? additionalData.type : questionTypes.MULTIPLE_CHOICE;
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];
        const isOptionBased = resolvedType === questionTypes.MULTIPLE_CHOICE || resolvedType === questionTypes.MULTIPLE_CORRECT;
        const showOptions = isOptionBased || options.length > 0;
        const canRemoveOption = !isOptionBased || options.length > 2;

        const typeOptionsHtml = MockTestEditorPage.QUESTION_TYPE_OPTIONS.map((typeOption) => `
            <option value="${typeOption.value}" ${typeOption.value === resolvedType ? "selected" : ""}>${MockTestEditorPage.#escapeHtml(typeOption.label)}</option>
        `).join("");

        const optionsHtml = options.map((optionText, optionIndex) => `
            <div class="mock-test-editor-option-row" data-option-index="${optionIndex}">
                <span class="mock-test-editor-option-letter">${MockTestEditorPage.#getOptionLetter(optionIndex)}</span>
                <input
                    type="text"
                    class="mock-test-editor-option-input"
                    data-item-index="${itemIndex}"
                    data-option-index="${optionIndex}"
                    value="${MockTestEditorPage.#escapeHtml(optionText)}"
                />
                <button
                    type="button"
                    class="mock-test-editor-remove-option-button"
                    data-item-index="${itemIndex}"
                    data-option-index="${optionIndex}"
                    ${canRemoveOption ? "" : "disabled title=\"At least 2 options are required\""}
                >&times;</button>
            </div>
        `).join("");

        const expectedAnswerFieldHtml = MockTestEditorPage.#renderExpectedAnswerField(questionItem, itemIndex, resolvedType, options);

        return this.#renderItemCardShell(itemIndex, `Q.${questionNumber}`, `
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Question type</label>
                <select class="mock-test-editor-question-type-select" data-item-index="${itemIndex}">
                    ${typeOptionsHtml}
                </select>
            </div>

            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Question text (HTML / LaTeX supported)</label>
                <rich-text-editor
                    class="mock-test-editor-question-text-editor mock-test-editor-rich-text-editor"
                    data-item-index="${itemIndex}"
                    data-rich-text-field="question"
                    placeholder="Question text..."
                ></rich-text-editor>
            </div>

            <div class="mock-test-editor-field mock-test-editor-options-section ${showOptions ? "" : "mock-test-editor-options-section-hidden"}">
                <label class="mock-test-editor-label">Options${isOptionBased ? " (minimum 2)" : ""}</label>
                <div class="mock-test-editor-options-list">${optionsHtml}</div>
                <button
                    type="button"
                    class="mock-test-editor-add-option-button"
                    data-item-index="${itemIndex}"
                >+ Add Option</button>
            </div>

            ${expectedAnswerFieldHtml}

            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Reason (optional)</label>
                <rich-text-editor
                    class="mock-test-editor-answer-reason-editor mock-test-editor-rich-text-editor"
                    data-item-index="${itemIndex}"
                    data-rich-text-field="answerReason"
                    placeholder="Why this answer is correct..."
                ></rich-text-editor>
            </div>

            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Solving steps (optional)</label>
                <rich-text-editor
                    class="mock-test-editor-solving-steps-editor mock-test-editor-rich-text-editor"
                    data-item-index="${itemIndex}"
                    data-rich-text-field="solvingSteps"
                    placeholder="Step-by-step working..."
                ></rich-text-editor>
            </div>

            <div class="mock-test-editor-field mock-test-editor-marks-field">
                <label class="mock-test-editor-label">Marks</label>
                <input
                    type="number"
                    step="any"
                    class="mock-test-editor-question-marks-input"
                    data-item-index="${itemIndex}"
                    value="${questionItem.getMarks() ?? 1}"
                />
            </div>
        `);
    }

    #bindItemEvents()
    {
        // Reorder / delete buttons
        this.querySelectorAll(".mock-test-editor-move-up-button").forEach((moveUpButton) =>
        {
            moveUpButton.addEventListener("click", () =>
            {
                const itemIndex = parseInt(moveUpButton.dataset.itemIndex, 10);
                this.#moveItem(itemIndex, itemIndex - 1);
            });
        });
        this.querySelectorAll(".mock-test-editor-move-down-button").forEach((moveDownButton) =>
        {
            moveDownButton.addEventListener("click", () =>
            {
                const itemIndex = parseInt(moveDownButton.dataset.itemIndex, 10);
                this.#moveItem(itemIndex, itemIndex + 1);
            });
        });
        this.querySelectorAll(".mock-test-editor-delete-item-button").forEach((deleteItemButton) =>
        {
            deleteItemButton.addEventListener("click", async () =>
            {
                const itemIndex = parseInt(deleteItemButton.dataset.itemIndex, 10);
                const confirmed = await DialogBox.confirm("Delete item", "Are you sure you want to remove this item from the mock test?");
                if (!confirmed)
                {
                    return;
                }
                this.#draftItems.splice(itemIndex, 1);
                this.#renderItems();
            });
        });

        // Title item input
        this.querySelectorAll(".mock-test-editor-title-item-input").forEach((titleInput) =>
        {
            titleInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(titleInput.dataset.itemIndex, 10);
                this.#draftItems[itemIndex].setTitle(titleInput.value);
            });
        });

        // (Instructions content is wired below via the generic
        // rich-text-editor binder, which handles setContent through
        // its field switch.)

        // Section inputs
        this.querySelectorAll(".mock-test-editor-section-title-input").forEach((sectionTitleInput) =>
        {
            sectionTitleInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(sectionTitleInput.dataset.itemIndex, 10);
                this.#draftItems[itemIndex].setTitle(sectionTitleInput.value);
            });
        });
        this.querySelectorAll(".mock-test-editor-section-description-input").forEach((sectionDescriptionInput) =>
        {
            sectionDescriptionInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(sectionDescriptionInput.dataset.itemIndex, 10);
                this.#draftItems[itemIndex].setDescription(sectionDescriptionInput.value);
            });
        });

        // Question fields
        this.querySelectorAll(".mock-test-editor-question-type-select").forEach((questionTypeSelect) =>
        {
            questionTypeSelect.addEventListener("change", () =>
            {
                const itemIndex = parseInt(questionTypeSelect.dataset.itemIndex, 10);
                const newType = parseInt(questionTypeSelect.value, 10);
                const additionalData = { ...this.#draftItems[itemIndex].getAdditionalData() };
                additionalData.type = newType;
                if (newType === questionTypes.MULTIPLE_CHOICE || newType === questionTypes.MULTIPLE_CORRECT)
                {
                    if (!Array.isArray(additionalData.options) || additionalData.options.length === 0)
                    {
                        additionalData.options = ["", "", "", ""];
                    }
                }
                this.#draftItems[itemIndex].setAdditionalData(additionalData);
                this.#renderItems();
            });
        });

        // (Question text wiring lives in the generic rich-text-editor
        // binder below.)

        this.querySelectorAll(".mock-test-editor-option-input").forEach((optionInput) =>
        {
            optionInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(optionInput.dataset.itemIndex, 10);
                const optionIndex = parseInt(optionInput.dataset.optionIndex, 10);
                const additionalData = { ...this.#draftItems[itemIndex].getAdditionalData() };
                const nextOptions = Array.isArray(additionalData.options) ? [...additionalData.options] : [];
                nextOptions[optionIndex] = optionInput.value;
                additionalData.options = nextOptions;
                this.#draftItems[itemIndex].setAdditionalData(additionalData);
            });
        });

        this.querySelectorAll(".mock-test-editor-remove-option-button").forEach((removeOptionButton) =>
        {
            removeOptionButton.addEventListener("click", () =>
            {
                if (removeOptionButton.hasAttribute("disabled"))
                {
                    return;
                }
                const itemIndex = parseInt(removeOptionButton.dataset.itemIndex, 10);
                const optionIndex = parseInt(removeOptionButton.dataset.optionIndex, 10);
                const draftItem = this.#draftItems[itemIndex];
                const additionalData = { ...draftItem.getAdditionalData() };
                const resolvedType = Number.isFinite(additionalData.type) ? additionalData.type : questionTypes.MULTIPLE_CHOICE;
                const isOptionBased = resolvedType === questionTypes.MULTIPLE_CHOICE || resolvedType === questionTypes.MULTIPLE_CORRECT;
                const previousOptions = Array.isArray(additionalData.options) ? additionalData.options : [];

                if (isOptionBased && previousOptions.length <= 2)
                {
                    return;
                }

                const nextOptions = [...previousOptions];
                nextOptions.splice(optionIndex, 1);
                additionalData.options = nextOptions;
                draftItem.setAdditionalData(additionalData);

                // Re-map the expected answer indices so any reference to the
                // removed option is dropped and indices above it shift down by one.
                const previousIndices = MockTestEditorPage.#parseExpectedAnswerToIndices(draftItem.getExpectedAnswer(), previousOptions.length);
                const nextIndices = new Set();
                for (const previousIndex of previousIndices)
                {
                    if (previousIndex === optionIndex)
                    {
                        continue;
                    }
                    nextIndices.add(previousIndex > optionIndex ? previousIndex - 1 : previousIndex);
                }
                draftItem.setExpectedAnswer(MockTestEditorPage.#indicesToExpectedAnswerString(nextIndices));

                this.#renderItems();
            });
        });

        this.querySelectorAll(".mock-test-editor-add-option-button").forEach((addOptionButton) =>
        {
            addOptionButton.addEventListener("click", () =>
            {
                const itemIndex = parseInt(addOptionButton.dataset.itemIndex, 10);
                const additionalData = { ...this.#draftItems[itemIndex].getAdditionalData() };
                const nextOptions = Array.isArray(additionalData.options) ? [...additionalData.options] : [];
                nextOptions.push("");
                additionalData.options = nextOptions;
                this.#draftItems[itemIndex].setAdditionalData(additionalData);
                this.#renderItems();
            });
        });

        this.querySelectorAll(".mock-test-editor-expected-answer-input").forEach((expectedAnswerInput) =>
        {
            expectedAnswerInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(expectedAnswerInput.dataset.itemIndex, 10);
                this.#draftItems[itemIndex].setExpectedAnswer(expectedAnswerInput.value);
            });
        });

        this.querySelectorAll(".mock-test-editor-expected-answer-select").forEach((expectedAnswerSelect) =>
        {
            expectedAnswerSelect.addEventListener("change", () =>
            {
                const itemIndex = parseInt(expectedAnswerSelect.dataset.itemIndex, 10);
                this.#draftItems[itemIndex].setExpectedAnswer(expectedAnswerSelect.value || "");
            });
        });

        this.querySelectorAll(".mock-test-editor-expected-answer-checkboxes").forEach((checkboxGroup) =>
        {
            const itemIndex = parseInt(checkboxGroup.dataset.itemIndex, 10);
            const checkboxes = checkboxGroup.querySelectorAll(".mock-test-editor-expected-answer-checkbox");
            for (const checkbox of checkboxes)
            {
                checkbox.addEventListener("change", () =>
                {
                    const checkedLetters = [];
                    for (const otherCheckbox of checkboxes)
                    {
                        if (otherCheckbox.checked)
                        {
                            checkedLetters.push(otherCheckbox.dataset.optionLetter);
                        }
                    }
                    this.#draftItems[itemIndex].setExpectedAnswer(checkedLetters.join(","));
                });
            }
        });

        // (Answer reason + solving steps are wired below via the
        // generic rich-text-editor binder.)

        // Populate + wire every rich-text-editor on the page.
        this.#bindRichTextEditors();

        this.querySelectorAll(".mock-test-editor-question-marks-input").forEach((questionMarksInput) =>
        {
            questionMarksInput.addEventListener("input", () =>
            {
                const itemIndex = parseInt(questionMarksInput.dataset.itemIndex, 10);
                const parsedMarks = parseFloat(questionMarksInput.value);
                this.#draftItems[itemIndex].setMarks(Number.isFinite(parsedMarks) ? parsedMarks : 0);
            });
        });

        // Add item button
        const addItemButton = this.querySelector(".mock-test-editor-add-item-button");
        if (addItemButton)
        {
            addItemButton.addEventListener("click", () => this.#showAddItemPicker());
        }
    }

    /**
     * Walks every <rich-text-editor> in the items container, populates
     * it from the draft model, and wires an input listener on its
     * inner contenteditable so live edits flow back into the draft.
     * Called after every re-render — each mount is fresh, so we can't
     * cache references across renders.
     */
    #bindRichTextEditors()
    {
        const richTextEditors = this.querySelectorAll(".mock-test-editor-rich-text-editor");
        for (const richTextEditor of richTextEditors)
        {
            const itemIndex = parseInt(richTextEditor.dataset.itemIndex, 10);
            const fieldName = richTextEditor.dataset.richTextField;
            const draftItem = this.#draftItems[itemIndex];
            if (!draftItem)
            {
                continue;
            }

            const initialValue = MockTestEditorPage.#readRichTextFieldFromItem(draftItem, fieldName);
            // The custom element's connectedCallback is synchronous on
            // upgrade, so the contenteditable child exists by the time
            // setInnerHtml is called here.
            if (typeof richTextEditor.setInnerHtml === "function")
            {
                richTextEditor.setInnerHtml(initialValue);
            }

            const editableElement = richTextEditor.querySelector("[contenteditable]");
            if (editableElement)
            {
                editableElement.addEventListener("input", () =>
                {
                    const updatedHtml = typeof richTextEditor.getInnerHtml === "function"
                        ? richTextEditor.getInnerHtml()
                        : editableElement.innerHTML;
                    MockTestEditorPage.#writeRichTextFieldToItem(this.#draftItems[itemIndex], fieldName, updatedHtml);
                });
            }
        }
    }

    static #readRichTextFieldFromItem(draftItem, fieldName)
    {
        if (fieldName === "question" && draftItem.getQuestion)
        {
            return draftItem.getQuestion() || "";
        }
        if (fieldName === "answerReason" && draftItem.getAnswerReason)
        {
            return draftItem.getAnswerReason() || "";
        }
        if (fieldName === "solvingSteps" && draftItem.getSolvingSteps)
        {
            return draftItem.getSolvingSteps() || "";
        }
        if (fieldName === "instructionsContent" && draftItem.getContent)
        {
            return draftItem.getContent() || "";
        }
        return "";
    }

    static #writeRichTextFieldToItem(draftItem, fieldName, updatedHtml)
    {
        if (!draftItem)
        {
            return;
        }
        if (fieldName === "question" && draftItem.setQuestion)
        {
            draftItem.setQuestion(updatedHtml);
        }
        else if (fieldName === "answerReason" && draftItem.setAnswerReason)
        {
            draftItem.setAnswerReason(updatedHtml);
        }
        else if (fieldName === "solvingSteps" && draftItem.setSolvingSteps)
        {
            draftItem.setSolvingSteps(updatedHtml);
        }
        else if (fieldName === "instructionsContent" && draftItem.setContent)
        {
            draftItem.setContent(updatedHtml);
        }
    }

    #moveItem(fromIndex, toIndex)
    {
        if (toIndex < 0 || toIndex >= this.#draftItems.length || fromIndex === toIndex)
        {
            return;
        }
        const [movedItem] = this.#draftItems.splice(fromIndex, 1);
        this.#draftItems.splice(toIndex, 0, movedItem);
        this.#renderItems();
    }

    async #showAddItemPicker()
    {
        const dialog = DialogBox.modal(`
            <div class="mock-test-editor-add-item-picker">
                <div class="mock-test-editor-add-item-picker-title">Add Item</div>
                <div class="mock-test-editor-add-item-picker-buttons">
                    ${MockTestEditorPage.ITEM_TYPE_PICKER_OPTIONS.map((typeOption) => `
                        <button
                            class="mock-test-editor-add-item-picker-option"
                            type="button"
                            data-item-type="${typeOption.value}"
                        >${MockTestEditorPage.#escapeHtml(typeOption.label)}</button>
                    `).join("")}
                </div>
            </div>
        `);

        dialog.style.padding = "0";
        dialog.style.width = "min(400px, 92vw)";

        dialog.querySelectorAll(".mock-test-editor-add-item-picker-option").forEach((optionButton) =>
        {
            optionButton.addEventListener("click", () =>
            {
                const selectedItemType = parseInt(optionButton.dataset.itemType, 10);
                dialog.close();
                this.#addNewItem(selectedItemType);
            });
        });
    }

    #addNewItem(itemType)
    {
        let newItem = null;
        const newItemId = getRandomUuid();

        if (itemType === mockTestItemTypes.TITLE)
        {
            newItem = new MockTestTitle(newItemId, "");
        }
        else if (itemType === mockTestItemTypes.INSTRUCTIONS)
        {
            newItem = new MockTestInstructions(newItemId, "");
        }
        else if (itemType === mockTestItemTypes.SECTION)
        {
            newItem = new MockTestSection(newItemId, "New Section", "");
        }
        else if (itemType === mockTestItemTypes.QUESTION)
        {
            newItem = new MockTestQuestion(
                newItemId,
                "",
                "",
                "",
                1,
                "",
                0,
                { type: questionTypes.MULTIPLE_CHOICE, options: ["", "", "", ""] },
                ""
            );
        }

        if (!newItem)
        {
            return;
        }

        this.#draftItems.push(newItem);
        this.#renderItems();
        // Scroll to the newly added item.
        const itemsContainer = this.querySelector(".mock-test-editor-items-container");
        if (itemsContainer && itemsContainer.lastElementChild)
        {
            itemsContainer.lastElementChild.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    // ── Action bar ─────────────────────────────────────────────────────────────

    #bindActionBarEvents()
    {
        const cancelButton = this.querySelector(".mock-test-editor-cancel-button");
        if (cancelButton)
        {
            cancelButton.addEventListener("click", () =>
            {
                PageNavigator.back();
            });
        }

        const saveButton = this.querySelector(".mock-test-editor-save-button");
        if (saveButton)
        {
            saveButton.addEventListener("click", () => this.#onSaveClicked());
        }

        const deleteButton = this.querySelector(".mock-test-editor-delete-button");
        if (deleteButton)
        {
            deleteButton.addEventListener("click", () => this.#onDeleteClicked());
        }

        const previewButton = this.querySelector(".mock-test-editor-preview-button");
        if (previewButton)
        {
            previewButton.addEventListener("click", () => this.#onPreviewClicked());
        }
    }

    /**
     * Opens the same mode + duration popup that the "Take Test" button uses,
     * fed with a transient MockTest built from the current (unsaved) draft.
     * Items are deep-cloned through toJson/fromJson so the live runner cannot
     * mutate the editor's draft state. Nothing is persisted: closing the
     * runner returns the user to the editor with their work intact.
     */
    async #onPreviewClicked()
    {
        const optionValidationError = this.#findFirstOptionValidationError();
        if (optionValidationError)
        {
            await DialogBox.alert("Not enough options", optionValidationError);
            return;
        }

        const previewTitle = `Preview: ${this.#draftTitle.trim() || "Untitled Mock Test"}`;
        const previewDeckId = this.#deck ? this.#deck.getId() : "";
        const clonedItems = this.#draftItems.map((draftItem) => MockTestItemFactory.fromJson(draftItem.toJson()));
        const clonedMarkingScheme = MockTestEditorPage.#cloneMarkingScheme(this.#draftMarkingScheme);

        const previewMockTest = new MockTest(
            MockTest.generateId(),
            previewDeckId,
            previewTitle,
            this.#draftDurationMinutes,
            clonedItems,
            [],
            new Lifecycle(),
            clonedMarkingScheme
        );

        MockTestStartDialog.show(previewMockTest, null, true);
    }

    async #onSaveClicked()
    {
        if (!this.#draftTitle.trim())
        {
            await DialogBox.alert("Title required", "Please enter a title for the mock test.");
            return;
        }

        const optionValidationError = this.#findFirstOptionValidationError();
        if (optionValidationError)
        {
            await DialogBox.alert("Not enough options", optionValidationError);
            return;
        }

        let targetMockTest = this.#originalMockTest;
        if (this.#bNewMockTest)
        {
            if (!this.#deck)
            {
                await DialogBox.alert("Cannot Save", "No target deck specified for this mock test.");
                return;
            }
            targetMockTest = new MockTest(
                MockTest.generateId(),
                this.#deck.getId(),
                this.#draftTitle.trim(),
                this.#draftDurationMinutes,
                [],
                [],
                new Lifecycle(),
                this.#draftMarkingScheme
            );
        }

        targetMockTest.setTitle(this.#draftTitle.trim());
        targetMockTest.setDuration(this.#draftDurationMinutes);
        targetMockTest.setMarkingScheme(this.#draftMarkingScheme);
        targetMockTest.setItems(this.#draftItems);

        if (this.#bNewMockTest)
        {
            this.#deck.addMockTest(targetMockTest);
        }

        try
        {
            await targetMockTest.save();
        }
        catch (saveError)
        {
            console.error("[MockTestEditorPage] Save failed:", saveError);
            await DialogBox.alert("Save failed", "Could not save the mock test. Please try again.");
            return;
        }

        PageNavigator.back();
    }

    async #onDeleteClicked()
    {
        if (this.#bNewMockTest || !this.#originalMockTest)
        {
            return;
        }

        const confirmed = await DialogBox.confirm(
            "Delete Mock Test",
            "Are you sure you want to delete this mock test? This action cannot be undone."
        );
        if (!confirmed)
        {
            return;
        }

        try
        {
            await this.#originalMockTest.delete();
        }
        catch (deleteError)
        {
            console.error("[MockTestEditorPage] Delete failed:", deleteError);
            await DialogBox.alert("Delete failed", "Could not delete the mock test. Please try again.");
            return;
        }

        PageNavigator.back();
    }

    /**
     * Walks the draft items and returns a human-readable error string for the
     * first MULTIPLE_CHOICE / MULTIPLE_CORRECT question that has fewer than
     * two options. Returns null when all option-based questions are valid.
     */
    #findFirstOptionValidationError()
    {
        let runningQuestionNumber = 0;
        for (const draftItem of this.#draftItems)
        {
            if (draftItem.getType() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            runningQuestionNumber += 1;
            const additionalData = draftItem.getAdditionalData() || {};
            const resolvedType = Number.isFinite(additionalData.type) ? additionalData.type : questionTypes.MULTIPLE_CHOICE;
            const isOptionBased = resolvedType === questionTypes.MULTIPLE_CHOICE || resolvedType === questionTypes.MULTIPLE_CORRECT;
            if (!isOptionBased)
            {
                continue;
            }
            const options = Array.isArray(additionalData.options) ? additionalData.options : [];
            if (options.length < 2)
            {
                return `Question ${runningQuestionNumber} needs at least 2 options.`;
            }
        }
        return null;
    }

    // ── Static helpers ─────────────────────────────────────────────────────────

    static #cloneMarkingScheme(markingScheme)
    {
        const source = markingScheme || MockTest.DEFAULT_MARKING_SCHEME;
        return {
            correctMarks: source.correctMarks ?? 0,
            wrongMarks: source.wrongMarks ?? 0,
            unattemptedMarks: source.unattemptedMarks ?? 0,
            partialMarks: source.partialMarks ?? 0,
            perTypeMarkingOverrides: source.perTypeMarkingOverrides ? { ...source.perTypeMarkingOverrides } : {},
            perSectionMarkingOverrides: Array.isArray(source.perSectionMarkingOverrides) ? source.perSectionMarkingOverrides.map((entry) => ({ ...entry })) : []
        };
    }

    static #getOptionLetter(optionIndex)
    {
        const upperA = 65;
        return String.fromCharCode(upperA + optionIndex);
    }

    /**
     * Renders the Expected Answer form field for a question. For MULTIPLE_CHOICE
     * questions this is a single-value dropdown of option letters; for
     * MULTIPLE_CORRECT it is a row of checkboxes (one per option letter); for
     * all other (subjective / objective-text) types it is the existing free
     * text input. The dropdown / checkbox state is derived from the stored
     * expected answer string, which may be a numeric index ("0") or a letter
     * ("A") — both formats are accepted on read; saves are normalized to
     * comma-separated uppercase letters.
     */
    static #renderExpectedAnswerField(questionItem, itemIndex, resolvedType, options)
    {
        const isOptionBased = resolvedType === questionTypes.MULTIPLE_CHOICE || resolvedType === questionTypes.MULTIPLE_CORRECT;
        const rawExpectedAnswer = questionItem.getExpectedAnswer() || "";

        if (!isOptionBased)
        {
            return `
                <div class="mock-test-editor-field">
                    <label class="mock-test-editor-label">Expected answer</label>
                    <input
                        type="text"
                        class="mock-test-editor-expected-answer-input"
                        data-item-index="${itemIndex}"
                        value="${MockTestEditorPage.#escapeHtml(rawExpectedAnswer)}"
                    />
                </div>
            `;
        }

        if (!Array.isArray(options) || options.length === 0)
        {
            return `
                <div class="mock-test-editor-field">
                    <label class="mock-test-editor-label">Expected answer</label>
                    <div class="mock-test-editor-expected-answer-empty">Add at least 2 options above to pick an expected answer.</div>
                </div>
            `;
        }

        const selectedIndices = MockTestEditorPage.#parseExpectedAnswerToIndices(rawExpectedAnswer, options.length);

        if (resolvedType === questionTypes.MULTIPLE_CHOICE)
        {
            const selectedIndex = selectedIndices.size > 0 ? selectedIndices.values().next().value : -1;
            const optionTags = options.map((optionText, optionIndex) =>
            {
                const letter = MockTestEditorPage.#getOptionLetter(optionIndex);
                const previewText = MockTestEditorPage.#truncateForOptionLabel(optionText) || "(empty)";
                const selectedAttribute = optionIndex === selectedIndex ? "selected" : "";
                return `<option value="${letter}" ${selectedAttribute}>${letter}. ${MockTestEditorPage.#escapeHtml(previewText)}</option>`;
            }).join("");
            return `
                <div class="mock-test-editor-field">
                    <label class="mock-test-editor-label">Expected answer</label>
                    <select class="mock-test-editor-expected-answer-select" data-item-index="${itemIndex}">
                        <option value="" ${selectedIndex === -1 ? "selected" : ""}>— Select correct option —</option>
                        ${optionTags}
                    </select>
                </div>
            `;
        }

        // MULTIPLE_CORRECT
        const checkboxRows = options.map((optionText, optionIndex) =>
        {
            const letter = MockTestEditorPage.#getOptionLetter(optionIndex);
            const previewText = MockTestEditorPage.#truncateForOptionLabel(optionText) || "(empty)";
            const checkedAttribute = selectedIndices.has(optionIndex) ? "checked" : "";
            return `
                <label class="mock-test-editor-expected-answer-checkbox-label">
                    <input
                        type="checkbox"
                        class="mock-test-editor-expected-answer-checkbox"
                        data-option-letter="${letter}"
                        ${checkedAttribute}
                    />
                    <span class="mock-test-editor-expected-answer-checkbox-text">${letter}. ${MockTestEditorPage.#escapeHtml(previewText)}</span>
                </label>
            `;
        }).join("");
        return `
            <div class="mock-test-editor-field">
                <label class="mock-test-editor-label">Expected answer (select all that apply)</label>
                <div class="mock-test-editor-expected-answer-checkboxes" data-item-index="${itemIndex}">
                    ${checkboxRows}
                </div>
            </div>
        `;
    }

    /**
     * Decodes a stored expected-answer string into a Set of zero-based option
     * indices. Accepts both numeric ("0,2") and letter ("A,C") tokens — the
     * generator emits numeric, the editor saves letters, and legacy data may
     * use either. Tokens that don't resolve to a valid option position are
     * silently dropped.
     */
    static #parseExpectedAnswerToIndices(rawValue, optionsCount)
    {
        const result = new Set();
        if (rawValue === null || rawValue === undefined)
        {
            return result;
        }
        const tokens = String(rawValue).trim().split(/[,;|\s/]+/).filter((token) => token.length > 0);
        for (const token of tokens)
        {
            const cleaned = token.replace(/[()\s\[\]]/g, "");
            if (cleaned === "")
            {
                continue;
            }
            const asNumber = parseInt(cleaned, 10);
            if (Number.isFinite(asNumber) && String(asNumber) === cleaned && asNumber >= 0 && asNumber < optionsCount)
            {
                result.add(asNumber);
                continue;
            }
            if (/^[a-zA-Z]$/.test(cleaned))
            {
                const letterIndex = cleaned.toUpperCase().charCodeAt(0) - 65;
                if (letterIndex >= 0 && letterIndex < optionsCount)
                {
                    result.add(letterIndex);
                }
            }
        }
        return result;
    }

    static #indicesToExpectedAnswerString(indices)
    {
        const sortedIndices = [...indices].sort((leftIndex, rightIndex) => leftIndex - rightIndex);
        return sortedIndices.map((index) => MockTestEditorPage.#getOptionLetter(index)).join(",");
    }

    static #truncateForOptionLabel(optionText)
    {
        const safeText = String(optionText || "").replace(/\s+/g, " ").trim();
        const maxLength = 60;
        if (safeText.length <= maxLength)
        {
            return safeText;
        }
        return safeText.slice(0, maxLength - 1) + "…";
    }

    static #escapeHtml(value)
    {
        if (value === null || value === undefined)
        {
            return "";
        }
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("mock-test-editor-page", MockTestEditorPage);
export default MockTestEditorPage;
