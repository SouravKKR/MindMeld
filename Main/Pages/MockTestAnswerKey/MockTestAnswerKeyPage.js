import { mockTestItemTypes } from "../../Globals/Enumerations/MockTestItemTypes.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import MockTestAnswerKeyPdfBuilder from "./Classes/MockTestAnswerKeyPdfBuilder.js";

// Requires: Pages/MockTestAnswerKey/Styles/MockTestAnswerKeyPage.css

/**
 * Full-screen viewer for the answer key of a mock test. Walks the items
 * in order and for every question shows the expected answer (rendered
 * as an option letter when the expected value points at an option),
 * the optional reason, and optional solving steps. A toolbar at the top
 * lets the user download the entire answer key as a PDF.
 *
 * Opened via PageNavigator.open("mock-test-answer-key-page", mockTest).
 */
class MockTestAnswerKeyPage extends HTMLElement
{
    static OPTION_LETTERS_UPPERCASE = ["A", "B", "C", "D", "E", "F", "G", "H"];

    #mockTest = null;

    initialize(mockTest)
    {
        this.#mockTest = mockTest;
    }

    connectedCallback()
    {
        if (!this.#mockTest)
        {
            this.innerHTML = `<header-component title="Answer Key"></header-component><div class="mock-test-answer-key-page-empty">No mock test loaded.</div>`;
            return;
        }

        const title = this.#mockTest.getTitle() || "Mock Test";
        const totalMarks = MockTestAnswerKeyPage.#computeTotalMarks(this.#mockTest);

        this.innerHTML = `
            <header-component title="Answer Key: ${MockTestAnswerKeyPage.#escapeHtml(title)}"></header-component>
            <div class="mock-test-answer-key-page-toolbar">
                <div class="mock-test-answer-key-page-toolbar-info">
                    <div class="mock-test-answer-key-page-toolbar-title">${MockTestAnswerKeyPage.#escapeHtml(title)}</div>
                    <div class="mock-test-answer-key-page-toolbar-meta">${totalMarks} marks total</div>
                </div>
                <button class="mock-test-answer-key-page-download-button" type="button">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-7 2h14v2H5v-2z"/>
                    </svg>
                    Download PDF
                </button>
            </div>
            <div class="mock-test-answer-key-page-scrollable">
                <div class="mock-test-answer-key-page-body"></div>
            </div>
        `;

        this.#renderBody();
        this.#bindEvents();
        this.#renderLatex();
    }

    #renderBody()
    {
        const bodyContainer = this.querySelector(".mock-test-answer-key-page-body");
        if (!bodyContainer)
        {
            return;
        }

        const items = this.#mockTest.getItems() || [];
        let runningQuestionNumber = 0;
        const renderedFragments = [];

        for (const item of items)
        {
            const itemType = item.getType();
            if (itemType === mockTestItemTypes.TITLE)
            {
                renderedFragments.push(MockTestAnswerKeyPage.#renderTitleItem(item));
            }
            else if (itemType === mockTestItemTypes.INSTRUCTIONS)
            {
                renderedFragments.push(MockTestAnswerKeyPage.#renderInstructionsItem(item));
            }
            else if (itemType === mockTestItemTypes.SECTION)
            {
                renderedFragments.push(MockTestAnswerKeyPage.#renderSectionItem(item));
            }
            else if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
                renderedFragments.push(MockTestAnswerKeyPage.#renderQuestionItem(item, runningQuestionNumber));
            }
        }

        bodyContainer.innerHTML = renderedFragments.join("");
    }

    #bindEvents()
    {
        const downloadButton = this.querySelector(".mock-test-answer-key-page-download-button");
        if (downloadButton)
        {
            downloadButton.addEventListener("click", () =>
            {
                try
                {
                    MockTestAnswerKeyPdfBuilder.downloadPdf(this.#mockTest);
                }
                catch (downloadError)
                {
                    console.error("[MockTestAnswerKeyPage] PDF download failed:", downloadError);
                    DialogBox.alert("Download Failed", "Could not generate the answer key PDF. Please try again.");
                }
            });
        }
    }

    #renderLatex()
    {
        const bodyContainer = this.querySelector(".mock-test-answer-key-page-body");
        if (!bodyContainer || typeof renderMathInElement === "undefined")
        {
            return;
        }

        renderMathInElement(bodyContainer,
        {
            delimiters:
            [
                { left: "\\(", right: "\\)", display: false },
                { left: "\\[", right: "\\]", display: true  }
            ],
            throwOnError: false
        });
    }

    // ── Renderers ──────────────────────────────────────────────────────────────

    static #renderTitleItem(titleItem)
    {
        const titleText = titleItem.getTitle() || "";
        return `<h2 class="mock-test-answer-key-title-item">${MockTestAnswerKeyPage.#escapeHtml(titleText)}</h2>`;
    }

    static #renderInstructionsItem(instructionsItem)
    {
        const content = instructionsItem.getContent() || "";
        return `
            <div class="mock-test-answer-key-instructions">
                <div class="mock-test-answer-key-instructions-label">General Instructions</div>
                <div class="mock-test-answer-key-instructions-content">${MockTestAnswerKeyPage.#escapeHtml(content)}</div>
            </div>
        `;
    }

    static #renderSectionItem(sectionItem)
    {
        const sectionTitle = sectionItem.getTitle ? sectionItem.getTitle() : "";
        const sectionDescription = sectionItem.getDescription ? sectionItem.getDescription() : "";
        return `
            <div class="mock-test-answer-key-section-banner">
                <div class="mock-test-answer-key-section-title">${MockTestAnswerKeyPage.#escapeHtml(sectionTitle)}</div>
                ${sectionDescription ? `<div class="mock-test-answer-key-section-description">${MockTestAnswerKeyPage.#escapeHtml(sectionDescription)}</div>` : ""}
            </div>
        `;
    }

    static #renderQuestionItem(questionItem, questionNumber)
    {
        const questionHtml = questionItem.getQuestion() || "";
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];
        const marks = questionItem.getMarks ? questionItem.getMarks() : 0;
        const expectedAnswerRaw = questionItem.getExpectedAnswer ? questionItem.getExpectedAnswer() : "";
        const answerReason = questionItem.getAnswerReason ? questionItem.getAnswerReason() : "";
        const solvingSteps = questionItem.getSolvingSteps ? questionItem.getSolvingSteps() : "";

        const expectedAnswerDisplay = MockTestAnswerKeyPage.formatExpectedAnswer(expectedAnswerRaw, options);

        const optionsHtml = options.length > 0
            ? `<div class="mock-test-answer-key-options">
                ${options.map((optionText, optionIndex) =>
                {
                    const optionLetter = MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE[optionIndex] || `${optionIndex + 1}`;
                    const isCorrect = MockTestAnswerKeyPage.#isCorrectOptionIndex(expectedAnswerRaw, optionIndex);
                    const correctClass = isCorrect ? " mock-test-answer-key-option-correct" : "";
                    return `
                        <div class="mock-test-answer-key-option${correctClass}">
                            <span class="mock-test-answer-key-option-label">${optionLetter}</span>
                            <span class="mock-test-answer-key-option-text">${MockTestAnswerKeyPage.#escapeHtml(optionText)}</span>
                        </div>
                    `;
                }).join("")}
            </div>`
            : "";

        const expectedAnswerHtml = `
            <div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Expected Answer</div>
                <div class="mock-test-answer-key-row-value ${expectedAnswerDisplay ? "" : "mock-test-answer-key-row-missing-value"}">
                    ${expectedAnswerDisplay ? MockTestAnswerKeyPage.#escapeHtml(expectedAnswerDisplay) : "— not provided —"}
                </div>
            </div>`;

        const reasonHtml = answerReason
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Reason</div>
                <div class="mock-test-answer-key-row-value">${MockTestAnswerKeyPage.#escapeHtml(answerReason)}</div>
            </div>`
            : "";

        const solvingStepsHtml = solvingSteps
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Solving Steps</div>
                <div class="mock-test-answer-key-row-value mock-test-answer-key-solving-steps">${MockTestAnswerKeyPage.#escapeHtml(solvingSteps)}</div>
            </div>`
            : "";

        return `
            <div class="mock-test-answer-key-question">
                <div class="mock-test-answer-key-question-header">
                    <div class="mock-test-answer-key-question-number">Q.${questionNumber}</div>
                    <div class="mock-test-answer-key-question-text">${questionHtml}</div>
                    <div class="mock-test-answer-key-question-marks">[${marks} M]</div>
                </div>
                ${optionsHtml}
                <div class="mock-test-answer-key-answer-block">
                    ${expectedAnswerHtml}
                    ${reasonHtml}
                    ${solvingStepsHtml}
                </div>
            </div>
        `;
    }

    // ── Public helpers (used by the PDF builder too) ───────────────────────────

    /**
     * Renders the expected-answer value as a human-friendly string. For
     * option-based questions, this means converting numeric indices
     * ("0", "2") or lowercase letters ("a", "b") into uppercase option
     * letters ("A", "B"). Comma- or pipe-separated multi-answer values
     * are decomposed and re-joined.
     * @returns {string}
     */
    static formatExpectedAnswer(rawValue, optionsArray)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return "";
        }

        const trimmedValue = String(rawValue).trim();
        if (trimmedValue === "")
        {
            return "";
        }

        const hasOptions = Array.isArray(optionsArray) && optionsArray.length > 0;
        if (!hasOptions)
        {
            return trimmedValue;
        }

        const tokens = trimmedValue.split(/[,;|\s/]+/).filter((token) => token.length > 0);
        if (tokens.length === 0)
        {
            return trimmedValue;
        }

        const renderedTokens = tokens.map((token) =>
        {
            const letter = MockTestAnswerKeyPage.#tokenToOptionLetter(token, optionsArray.length);
            return letter || token;
        });

        // If at least one token resolved to a letter, show the joined letters
        // (covers MULTIPLE_CORRECT with "0,2" or "a,c"). Otherwise show the
        // raw value as-is — it might be a free-text expected answer.
        const anyResolved = renderedTokens.some((rendered, index) => rendered !== tokens[index]);
        if (anyResolved)
        {
            return renderedTokens.join(", ");
        }
        return trimmedValue;
    }

    static #tokenToOptionLetter(token, optionsLength)
    {
        const cleaned = token.replace(/[()\s]/g, "");
        if (cleaned === "")
        {
            return null;
        }
        const asNumber = parseInt(cleaned, 10);
        if (Number.isFinite(asNumber) && asNumber >= 0 && asNumber < optionsLength)
        {
            return MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE[asNumber] || null;
        }
        if (/^[a-zA-Z]$/.test(cleaned))
        {
            const upperLetter = cleaned.toUpperCase();
            const letterIndex = upperLetter.charCodeAt(0) - 65;
            if (letterIndex >= 0 && letterIndex < optionsLength)
            {
                return upperLetter;
            }
        }
        return null;
    }

    static #isCorrectOptionIndex(rawValue, optionIndex)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return false;
        }
        const tokens = String(rawValue).trim().split(/[,;|\s/]+/).filter((token) => token.length > 0);
        for (const token of tokens)
        {
            const cleaned = token.replace(/[()\s]/g, "");
            const asNumber = parseInt(cleaned, 10);
            if (Number.isFinite(asNumber) && asNumber === optionIndex)
            {
                return true;
            }
            if (/^[a-zA-Z]$/.test(cleaned))
            {
                const letterIndex = cleaned.toUpperCase().charCodeAt(0) - 65;
                if (letterIndex === optionIndex)
                {
                    return true;
                }
            }
        }
        return false;
    }

    static #computeTotalMarks(mockTest)
    {
        const items = mockTest.getItems ? mockTest.getItems() : [];
        let totalMarks = 0;
        for (const item of items)
        {
            if (item.getType() === mockTestItemTypes.QUESTION && item.getMarks)
            {
                totalMarks += item.getMarks();
            }
        }
        return totalMarks;
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

customElements.define("mock-test-answer-key-page", MockTestAnswerKeyPage);
export default MockTestAnswerKeyPage;
