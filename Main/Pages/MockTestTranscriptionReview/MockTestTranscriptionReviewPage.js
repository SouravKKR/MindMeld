import { mockTestItemTypes } from "../../Globals/Enumerations/MockTestItemTypes.js";
import { questionTypes } from "../../Globals/Enumerations/QuestionTypes.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import HtmlSanitizer from "../../Globals/Classes/HtmlSanitizer.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import CreditNotice from "../../Globals/Classes/Credits/CreditNotice.js";
import TaskProgressTracker from "../../Globals/Classes/Task/TaskProgressTracker.js";
import MockTestItemFactory from "../../Globals/Model/MockTestEntities/MockTestItemFactory.js";
import MockTestSession from "../Study/Classes/MockTestSession.js";
import "../CardEditor/Components/RichTextEditor.js";

// Requires: Pages/MockTestTranscriptionReview/Styles/MockTestTranscriptionReviewPage.css

/**
 * The offline "read-back" review screen. This is the ONLY thing offline
 * evaluation adds ahead of the normal grading flow:
 *
 *   1. Uploads the candidate's scanned answer sheets to
 *      /MockTest/TranscribeOfflineAttempt.
 *   2. Waits for the Gemini vision worker to transcribe the handwriting into
 *      per-question answers (polling the task via TaskProgressTracker).
 *   3. Fetches the transcription and renders it as an EDITABLE form — each
 *      answer pre-filled so the candidate can fix any handwriting misreads.
 *   4. On "Confirm & Evaluate", stamps the (possibly edited) answers onto a
 *      clone of the mock-test items and hands off to
 *      MockTestSession.gradeAndNavigate — from which point an offline attempt is
 *      byte-for-byte identical to an online one, landing on the answer-key page.
 *
 * Opened via PageNavigator.clearAndOpen("mock-test-transcription-review-page",
 * mockTest, scanFiles, attemptId).
 */
class MockTestTranscriptionReviewPage extends HTMLElement
{
    static OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

    static SUBJECTIVE_MIN_HEIGHT_PX = new Map
    ([
        [questionTypes.SHORT_SUBJECTIVE,      80],
        [questionTypes.MEDIUM_SUBJECTIVE,    160],
        [questionTypes.LONG_SUBJECTIVE,      240],
        [questionTypes.VERY_LONG_SUBJECTIVE, 360]
    ]);

    static OPTION_BASED_QUESTION_TYPES = new Set([questionTypes.MULTIPLE_CHOICE, questionTypes.MULTIPLE_CORRECT]);

    #mockTest = null;
    #scanFiles = [];
    #attemptId = "";
    #taskId = null;
    #transcription = null;
    #cancelled = false;
    // questionId → () => string
    #answerExtractors = new Map();

    initialize(mockTest, scanFiles, attemptId)
    {
        this.#mockTest = mockTest;
        this.#scanFiles = Array.isArray(scanFiles) ? scanFiles : [];
        this.#attemptId = attemptId || "";
    }

    disconnectedCallback()
    {
        this.#cancelled = true;
    }

    async connectedCallback()
    {
        if (!this.#mockTest)
        {
            this.innerHTML = `<div class="mock-test-transcription-review-page-empty">No mock test loaded.</div>`;
            return;
        }

        // Materialise plaintext question content for a paid deck before rendering
        // the review form (no-op for a normal deck).
        try { await this.#mockTest.decryptForStudy(); } catch (decryptError) { /* best effort */ }

        this.#renderProgressShell();
        this.#runPipeline();
    }

    // ── Pipeline: upload → poll → fetch → review ────────────────────────────────

    async #runPipeline()
    {
        try
        {
            this.#updateProgress("Uploading your answer sheets…", 0.05);
            const taskId = await this.#uploadScans();
            if (this.#cancelled)
            {
                return;
            }
            this.#taskId = taskId;

            this.#updateProgress("Reading your handwriting…", 0.15);
            await TaskProgressTracker.pollUntilTerminal(taskId, (statusEvent) =>
            {
                if (this.#cancelled || statusEvent.phase !== "progress")
                {
                    return;
                }
                const completionFraction = MockTestTranscriptionReviewPage.#extractCompletion(statusEvent.taskTree);
                this.#updateProgress("Reading your handwriting…", 0.15 + completionFraction * 0.8);
            });
            if (this.#cancelled)
            {
                return;
            }

            const transcription = await this.#fetchTranscription(taskId);
            if (this.#cancelled)
            {
                return;
            }
            this.#transcription = transcription;
            this.#renderReview(transcription);
        }
        catch (pipelineError)
        {
            if (this.#cancelled)
            {
                return;
            }
            console.error("[MockTestTranscriptionReviewPage] transcription pipeline failed:", pipelineError);
            this.#renderError(pipelineError);
        }
    }

    async #uploadScans()
    {
        const formData = new FormData();
        formData.append("mockTestId", this.#mockTest.getId());
        formData.append("attemptId", this.#attemptId);
        const paidDeckId = this.#mockTest.getDeck()?.getAdditionalData?.()?.paidDeckId || null;
        if (paidDeckId)
        {
            formData.append("paidDeckId", paidDeckId);
        }
        for (const scanFile of this.#scanFiles)
        {
            formData.append("scan", scanFile, scanFile.name);
        }

        const response = await fetch("/MockTest/TranscribeOfflineAttempt", {
            method: "POST",
            credentials: "include",
            body: formData
        });

        if (response.status === 402)
        {
            const insufficientDetail = await response.json().catch(() => ({}));
            await CreditNotice.showInsufficientCredits(insufficientDetail);
            const creditError = new Error("INSUFFICIENT_CREDITS");
            creditError.code = "INSUFFICIENT_CREDITS";
            throw creditError;
        }

        if (!response.ok)
        {
            const errorBody = await response.text().catch(() => "");
            throw new Error(`Upload failed (${response.status})${errorBody ? ` — ${errorBody}` : ""}`);
        }

        const responseBody = await response.json().catch(() => ({}));
        if (!responseBody || typeof responseBody.taskId !== "string" || responseBody.taskId.length === 0)
        {
            throw new Error("The server did not return a transcription task.");
        }
        return responseBody.taskId;
    }

    async #fetchTranscription(taskId)
    {
        // The poll already reported the task terminal; the worker writes its
        // result BEFORE flipping the task COMPLETED, so the object is normally
        // present immediately. Retry a couple of times to ride out eventual
        // consistency, then fall back to a blank (manually-fillable) form.
        for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1)
        {
            const response = await fetch("/MockTest/GetTranscriptionResult", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId })
            });

            if (!response.ok)
            {
                throw new Error(`Could not fetch the transcription (${response.status}).`);
            }

            const responseBody = await response.json().catch(() => ({}));
            if (responseBody && responseBody.ready === true && responseBody.transcription)
            {
                return responseBody.transcription;
            }
            if (responseBody && responseBody.failed === true)
            {
                return null;
            }
            await MockTestTranscriptionReviewPage.#delay(1500);
        }
        return null;
    }

    // ── Progress + error rendering ──────────────────────────────────────────────

    #renderProgressShell()
    {
        this.innerHTML = `
            <div class="mock-test-transcription-review-page-root">
                <div class="mock-test-transcription-review-page-status-card">
                    <div class="mock-test-transcription-review-page-spinner"></div>
                    <div class="mock-test-transcription-review-page-status-label">Preparing…</div>
                    <div class="mock-test-transcription-review-page-progress-track">
                        <div class="mock-test-transcription-review-page-progress-fill" style="width:0%;"></div>
                    </div>
                    <div class="mock-test-transcription-review-page-status-hint">Reading handwriting can take up to a minute. Keep this page open.</div>
                </div>
            </div>
        `;
    }

    #updateProgress(label, fraction)
    {
        const labelElement = this.querySelector(".mock-test-transcription-review-page-status-label");
        if (labelElement)
        {
            labelElement.textContent = label;
        }
        const fillElement = this.querySelector(".mock-test-transcription-review-page-progress-fill");
        if (fillElement)
        {
            const clampedPercent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
            fillElement.style.width = `${clampedPercent}%`;
        }
    }

    #renderError(error)
    {
        const bInsufficientCredits = error && error.code === "INSUFFICIENT_CREDITS";
        const message = bInsufficientCredits
            ? "You don't have enough credits to read this answer sheet right now. Top up and try again, or discard this attempt."
            : "We couldn't read your answer sheets just now. You can try uploading again, or discard this attempt.";

        this.innerHTML = `
            <div class="mock-test-transcription-review-page-root">
                <div class="mock-test-transcription-review-page-status-card">
                    <div class="mock-test-transcription-review-page-error-title">Couldn't process your scans</div>
                    <div class="mock-test-transcription-review-page-error-message">${MockTestTranscriptionReviewPage.#escapeHtml(message)}</div>
                    <div class="mock-test-transcription-review-page-error-actions">
                        ${bInsufficientCredits ? "" : `<button class="mock-test-transcription-review-page-retry-button" type="button">Try again</button>`}
                        <button class="mock-test-transcription-review-page-discard-button" type="button">Discard attempt</button>
                    </div>
                </div>
            </div>
        `;

        const retryButton = this.querySelector(".mock-test-transcription-review-page-retry-button");
        if (retryButton)
        {
            retryButton.addEventListener("click", () =>
            {
                this.#renderProgressShell();
                this.#runPipeline();
            });
        }
        const discardButton = this.querySelector(".mock-test-transcription-review-page-discard-button");
        if (discardButton)
        {
            discardButton.addEventListener("click", () => this.#discard());
        }
    }

    // ── Review form ─────────────────────────────────────────────────────────────

    #renderReview(transcription)
    {
        const answerByQuestionId = new Map();
        const unmatchedBlocks = [];
        let bTranscriptionFailed = false;

        if (transcription && Array.isArray(transcription.answers))
        {
            for (const answerEntry of transcription.answers)
            {
                if (answerEntry && answerEntry.questionId !== undefined && answerEntry.questionId !== null)
                {
                    answerByQuestionId.set(String(answerEntry.questionId), typeof answerEntry.answer === "string" ? answerEntry.answer : "");
                }
            }
            if (Array.isArray(transcription.unmatched))
            {
                for (const unmatchedEntry of transcription.unmatched)
                {
                    if (unmatchedEntry)
                    {
                        unmatchedBlocks.push(unmatchedEntry);
                    }
                }
            }
            bTranscriptionFailed = !!(transcription.summary && transcription.summary.transcriptionFailed);
        }
        else
        {
            bTranscriptionFailed = true;
        }

        const title = this.#mockTest.getTitle() || "Mock Test";
        const warningHtml = this.#buildWarningHtml(bTranscriptionFailed, unmatchedBlocks);
        const itemsHtml = this.#buildItemsHtml(answerByQuestionId);

        this.innerHTML = `
            <div class="mock-test-transcription-review-page-root">
                <div class="mock-test-transcription-review-page-header">
                    <div class="mock-test-transcription-review-page-header-titles">
                        <div class="mock-test-transcription-review-page-header-title">Review your answers</div>
                        <div class="mock-test-transcription-review-page-header-subtitle">${MockTestTranscriptionReviewPage.#escapeHtml(title)}</div>
                    </div>
                    <button class="mock-test-transcription-review-page-discard-button" type="button">Discard</button>
                </div>
                <div class="mock-test-transcription-review-page-intro">
                    We read your handwriting from the scans below. Check each answer and fix anything we got wrong, then evaluate. What you confirm here is exactly what gets graded.
                </div>
                ${warningHtml}
                <div class="mock-test-transcription-review-page-items">${itemsHtml}</div>
                <div class="mock-test-transcription-review-page-action-bar">
                    <button class="mock-test-transcription-review-page-confirm-button" type="button">Confirm &amp; Evaluate</button>
                </div>
            </div>
        `;

        this.#installAnswerExtractorsAndPrefill(answerByQuestionId);
        this.#renderLatex();
        this.#bindReviewEvents();
    }

    #buildWarningHtml(bTranscriptionFailed, unmatchedBlocks)
    {
        const warnings = [];
        if (bTranscriptionFailed)
        {
            warnings.push("We couldn't automatically read your handwriting this time. Please type your answers below before evaluating.");
        }
        if (unmatchedBlocks.length > 0)
        {
            const seenNumbers = unmatchedBlocks
                .map((entry) => MockTestTranscriptionReviewPage.#escapeHtml(String(entry.questionNumberSeen || "?")))
                .join(", ");
            warnings.push(`Some writing on your sheet was labelled with a question number we couldn't match (${seenNumbers}). Check those answers landed on the right question.`);
        }
        if (warnings.length === 0)
        {
            return "";
        }
        return `<div class="mock-test-transcription-review-page-warning">${warnings.map((warningText) => `<div>${warningText}</div>`).join("")}</div>`;
    }

    #buildItemsHtml(answerByQuestionId)
    {
        const items = this.#mockTest.getItems() || [];
        let runningQuestionNumber = 0;
        let currentSection = null;
        const fragments = [];

        for (const item of items)
        {
            const itemType = item.getType();
            if (itemType === mockTestItemTypes.TITLE)
            {
                fragments.push(`<h2 class="mock-test-transcription-review-page-title-item">${MockTestTranscriptionReviewPage.#escapeHtml(item.getTitle() || "")}</h2>`);
            }
            else if (itemType === mockTestItemTypes.INSTRUCTIONS)
            {
                fragments.push(`
                    <div class="mock-test-transcription-review-page-instructions">
                        <div class="mock-test-transcription-review-page-instructions-label">General Instructions</div>
                        <div class="mock-test-transcription-review-page-instructions-content">${MockTestTranscriptionReviewPage.#escapeHtml(item.getContent() || "")}</div>
                    </div>
                `);
            }
            else if (itemType === mockTestItemTypes.SECTION)
            {
                currentSection = item;
                const sectionTitle = item.getTitle ? item.getTitle() : "";
                fragments.push(`<div class="mock-test-transcription-review-page-section-banner">${MockTestTranscriptionReviewPage.#escapeHtml(sectionTitle)}</div>`);
            }
            else if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
                fragments.push(this.#buildQuestionHtml(item, runningQuestionNumber, currentSection, answerByQuestionId));
            }
        }

        return fragments.join("");
    }

    #buildQuestionHtml(questionItem, questionNumber, currentSection, answerByQuestionId)
    {
        const questionId = questionItem.getId();
        const questionHtml = HtmlSanitizer.sanitize(questionItem.getQuestion() || "");
        const marks = MockTestSession.resolveEffectiveQuestionMarks(this.#mockTest, questionItem, currentSection);
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const questionType = additionalData.type ?? null;
        const transcribedAnswer = answerByQuestionId.get(String(questionId)) || "";

        const inputHtml = this.#buildInputHtml(questionId, questionType, additionalData, transcribedAnswer);

        return `
            <div class="mock-test-transcription-review-page-question" data-question-id="${MockTestTranscriptionReviewPage.#escapeHtml(questionId)}">
                <div class="mock-test-transcription-review-page-question-header">
                    <div class="mock-test-transcription-review-page-question-number">Q.${questionNumber}</div>
                    <div class="mock-test-transcription-review-page-question-text">${questionHtml}</div>
                    <div class="mock-test-transcription-review-page-question-marks">[${marks} M]</div>
                </div>
                <div class="mock-test-transcription-review-page-question-input">${inputHtml}</div>
            </div>
        `;
    }

    #buildInputHtml(questionId, questionType, additionalData, transcribedAnswer)
    {
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];

        if (MockTestTranscriptionReviewPage.OPTION_BASED_QUESTION_TYPES.has(questionType))
        {
            const selectedIndices = MockTestTranscriptionReviewPage.#parseIndexSet(transcribedAnswer);
            return `
                <div class="mock-test-transcription-review-page-options">
                    ${options.map((optionText, optionIndex) => `
                        <label class="mock-test-transcription-review-page-option">
                            <input
                                type="checkbox"
                                name="review-question-${MockTestTranscriptionReviewPage.#escapeHtml(questionId)}"
                                value="${optionIndex}"
                                ${selectedIndices.has(optionIndex) ? "checked" : ""}
                            />
                            <span class="mock-test-transcription-review-page-option-label">${MockTestTranscriptionReviewPage.OPTION_LABELS[optionIndex] || optionIndex + 1}</span>
                            <span class="mock-test-transcription-review-page-option-text">${MockTestTranscriptionReviewPage.#escapeHtml(optionText)}</span>
                        </label>
                    `).join("")}
                </div>
            `;
        }

        if (questionType === questionTypes.OBJECTIVE_SINGLE_WORD_OR_PHRASE)
        {
            return `
                <input
                    type="text"
                    class="mock-test-transcription-review-page-objective-input"
                    placeholder="Your answer…"
                    value="${MockTestTranscriptionReviewPage.#escapeHtml(MockTestTranscriptionReviewPage.#stripHtmlToText(transcribedAnswer))}"
                />
            `;
        }

        if (MockTestTranscriptionReviewPage.SUBJECTIVE_MIN_HEIGHT_PX.has(questionType))
        {
            const minHeightPx = MockTestTranscriptionReviewPage.SUBJECTIVE_MIN_HEIGHT_PX.get(questionType);
            // The transcribed HTML is applied via setInnerHtml AFTER the editor
            // upgrades (see #installAnswerExtractorsAndPrefill) so its own
            // sanitizer runs and lists/formatting round-trip.
            return `
                <div class="mock-test-transcription-review-page-subjective-wrapper" style="min-height:${minHeightPx}px;">
                    <rich-text-editor class="mock-test-transcription-review-page-subjective-editor" placeholder="Your answer…"></rich-text-editor>
                </div>
            `;
        }

        return `
            <input
                type="text"
                class="mock-test-transcription-review-page-objective-input"
                placeholder="Your answer…"
                value="${MockTestTranscriptionReviewPage.#escapeHtml(MockTestTranscriptionReviewPage.#stripHtmlToText(transcribedAnswer))}"
            />
        `;
    }

    #installAnswerExtractorsAndPrefill(answerByQuestionId)
    {
        const items = this.#mockTest.getItems() || [];
        for (const item of items)
        {
            if (item.getType() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            const questionId = item.getId();
            const questionElement = this.querySelector(`[data-question-id="${CSS && CSS.escape ? CSS.escape(questionId) : questionId}"]`);
            if (!questionElement)
            {
                continue;
            }
            const additionalData = item.getAdditionalData ? item.getAdditionalData() : {};
            const questionType = additionalData.type ?? null;

            if (MockTestTranscriptionReviewPage.OPTION_BASED_QUESTION_TYPES.has(questionType))
            {
                this.#answerExtractors.set(questionId, () =>
                {
                    const checkedBoxes = questionElement.querySelectorAll('input[type="checkbox"]:checked');
                    const selectedIndices = Array.from(checkedBoxes).map((checkbox) => parseInt(checkbox.value, 10));
                    return JSON.stringify(selectedIndices);
                });
                continue;
            }

            if (MockTestTranscriptionReviewPage.SUBJECTIVE_MIN_HEIGHT_PX.has(questionType))
            {
                const editor = questionElement.querySelector(".mock-test-transcription-review-page-subjective-editor");
                const transcribedAnswer = answerByQuestionId.get(String(questionId)) || "";
                if (editor && typeof editor.setInnerHtml === "function" && transcribedAnswer)
                {
                    editor.setInnerHtml(transcribedAnswer);
                }
                this.#answerExtractors.set(questionId, () =>
                {
                    return editor && typeof editor.getInnerHtml === "function" ? editor.getInnerHtml() : "";
                });
                continue;
            }

            this.#answerExtractors.set(questionId, () =>
            {
                const textInput = questionElement.querySelector(".mock-test-transcription-review-page-objective-input");
                return textInput ? textInput.value.trim() : "";
            });
        }
    }

    #renderLatex()
    {
        const itemsContainer = this.querySelector(".mock-test-transcription-review-page-items");
        if (!itemsContainer || typeof renderMathInElement === "undefined")
        {
            return;
        }
        renderMathInElement(itemsContainer,
        {
            delimiters:
            [
                { left: "\\(", right: "\\)", display: false },
                { left: "\\[", right: "\\]", display: true }
            ],
            throwOnError: false
        });
    }

    #bindReviewEvents()
    {
        const confirmButton = this.querySelector(".mock-test-transcription-review-page-confirm-button");
        if (confirmButton)
        {
            confirmButton.addEventListener("click", () => this.#onConfirmClicked());
        }
        const discardButton = this.querySelector(".mock-test-transcription-review-page-discard-button");
        if (discardButton)
        {
            discardButton.addEventListener("click", () => this.#discard());
        }
    }

    async #onConfirmClicked()
    {
        const confirmButton = this.querySelector(".mock-test-transcription-review-page-confirm-button");
        if (confirmButton)
        {
            confirmButton.disabled = true;
        }

        // Clone the blueprint items and stamp the reviewed answers onto them,
        // exactly the way the online runner does before grading.
        const sourceItems = this.#mockTest.getItems() || [];
        const clonedItems = sourceItems.map((sourceItem) => MockTestItemFactory.fromJson(sourceItem.toJson()));

        for (const clonedItem of clonedItems)
        {
            if (clonedItem.getType() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            const extractor = this.#answerExtractors.get(clonedItem.getId());
            if (extractor && clonedItem.setAnswer)
            {
                clonedItem.setAnswer(extractor());
            }
        }

        const additionalData = this.#taskId ? { transcriptionTaskId: this.#taskId } : null;
        await MockTestSession.gradeAndNavigate(this.#mockTest, clonedItems, { additionalData });
    }

    async #discard()
    {
        const confirmed = await DialogBox.confirm(
            "Discard attempt?",
            "Your scanned answers will be discarded and this attempt will not be graded. Are you sure?"
        );
        if (!confirmed)
        {
            return;
        }
        this.#cancelled = true;
        PageNavigator.clearAndOpen("home-page");
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    static #extractCompletion(taskTree)
    {
        if (taskTree && typeof taskTree.completion === "number")
        {
            return Math.max(0, Math.min(1, taskTree.completion));
        }
        return 0;
    }

    static #parseIndexSet(rawValue)
    {
        const indices = new Set();
        if (typeof rawValue !== "string")
        {
            return indices;
        }
        const trimmed = rawValue.trim();
        if (!trimmed)
        {
            return indices;
        }
        try
        {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
            {
                for (const value of parsed)
                {
                    const numeric = parseInt(value, 10);
                    if (Number.isFinite(numeric))
                    {
                        indices.add(numeric);
                    }
                }
                return indices;
            }
            if (typeof parsed === "number" && Number.isFinite(parsed))
            {
                indices.add(parsed);
                return indices;
            }
        }
        catch (parseError)
        {
            /* not JSON — fall through to single-int parse */
        }
        const singleNumeric = parseInt(trimmed, 10);
        if (Number.isFinite(singleNumeric))
        {
            indices.add(singleNumeric);
        }
        return indices;
    }

    static #stripHtmlToText(value)
    {
        if (!value)
        {
            return "";
        }
        return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    static #delay(milliseconds)
    {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    static #escapeHtml(value)
    {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

customElements.define("mock-test-transcription-review-page", MockTestTranscriptionReviewPage);

export default MockTestTranscriptionReviewPage;
