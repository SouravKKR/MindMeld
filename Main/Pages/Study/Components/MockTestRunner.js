import { mockTestItemTypes } from "../../../Globals/Enumerations/MockTestItemTypes.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { getRandomUuid } from "../../../Globals/UtilityFunctions/GetRandomUuid.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import MockTestItemFactory from "../../../Globals/Model/MockTestEntities/MockTestItemFactory.js";
import RichTextEditor from "../../CardEditor/Components/RichTextEditor.js";
import TutorialEngine from "../../../Globals/Classes/TutorialEngine.js";

// Requires: Pages/Study/Styles/MockTestRunner.css

/**
 * The mock-test taking surface. Renders every item (title, instructions,
 * section, question) in order, captures answers per question, runs a
 * countdown timer in the sticky header, and routes the user through an
 * offline upload pane when the test runs in offline mode.
 *
 * The runner deliberately keeps answers in memory only. On submission
 * the items are deep-cloned, stamped with the user's answers (online)
 * or scan upload paths (offline), and handed back to MockTestSession
 * which persists a MockTestAttempt on the parent MockTest.
 */
class MockTestRunner extends HTMLElement
{
    static MODE_ONLINE = "online";
    static MODE_OFFLINE = "offline";

    // Both single-correct and multi-correct MCQs render with checkbox
    // inputs so the user can't tell from the UI whether the question
    // permits multiple selections. If they tick more than one for a
    // single-correct question, it's marked wrong — that's the intent.
    static OPTION_BASED_QUESTION_TYPES = new Set([questionTypes.MULTIPLE_CHOICE, questionTypes.MULTIPLE_CORRECT]);

    // Subjective question types render a rich-text-editor. Min-height
    // is proportional to the PDF's blank-line counts (3 / 6 / 10 / 14)
    // so on-screen sizing matches what the user is used to from print.
    static SUBJECTIVE_MIN_HEIGHT_PX = new Map
    ([
        [questionTypes.SHORT_SUBJECTIVE,      80],
        [questionTypes.MEDIUM_SUBJECTIVE,    160],
        [questionTypes.LONG_SUBJECTIVE,      240],
        [questionTypes.VERY_LONG_SUBJECTIVE, 360]
    ]);

    static OPTION_LABELS = ["A", "B", "C", "D", "E", "F"];

    static TIMER_TICK_INTERVAL_MS = 1000;

    #mockTest = null;
    #sessionOptions = null;
    #onSubmitCallback = null;
    #onOfflineSubmitCallback = null;
    // questionId → () => string
    #answerExtractors = new Map();
    #timerIntervalHandle = null;
    #remainingSeconds = 0;
    #isActive = false;
    #attemptId = "";
    #pendingUploadFiles = [];
    #popstateHandler = null;
    #fullscreenChangeHandler = null;

    /**
     * Called by MockTestSession.start() before insertion into the DOM.
     * @param {MockTest} mockTest
     * @param {{mode: string, durationMinutes: number}} sessionOptions
     * @param {(clonedItems: Array, additionalData: Object|null) => void} onSubmitCallback
     *     Online path: hands back the cloned items stamped with on-screen answers.
     * @param {(scanFiles: File[], attemptId: string) => void} onOfflineSubmitCallback
     *     Offline path: hands back the raw scanned answer-sheet files so the
     *     session can upload them for transcription — the answers themselves
     *     live on paper, not in the DOM.
     */
    initialize(mockTest, sessionOptions, onSubmitCallback, onOfflineSubmitCallback = null)
    {
        this.#mockTest = mockTest;
        this.#sessionOptions = sessionOptions;
        this.#onSubmitCallback = onSubmitCallback;
        this.#onOfflineSubmitCallback = onOfflineSubmitCallback;
        this.#attemptId = getRandomUuid();
    }

    connectedCallback()
    {
        if (!this.#mockTest || !this.#sessionOptions)
        {
            return;
        }

        this.#renderShell();
        this.#renderItems();
        this.#renderLatex();
        this.#bindUiEvents();
        this.#installBackNavigationGuard();
        this.#installFullscreenWatcher();

        this.#isActive = true;
        const durationSeconds = Math.max(1, this.#sessionOptions.durationMinutes * 60);
        this.#startTimer(durationSeconds);

        this.#refreshFullscreenAffordance();
    }

    disconnectedCallback()
    {
        this.#stopTimer();
        this.#removeBackNavigationGuard();
        this.#removeFullscreenWatcher();
    }

    // ── Rendering ──────────────────────────────────────────────────────────────

    #renderShell()
    {
        const mockTestTitle = this.#mockTest.getTitle() || "Mock Test";
        const totalMarks = MockTestRunner.#computeTotalMarks(this.#mockTest);
        const markingSchemeText = MockTestRunner.#formatMarkingSchemeSummary(this.#mockTest);
        const modeLabel = this.#sessionOptions.mode === MockTestRunner.MODE_OFFLINE ? "Offline" : "Online";

        const offlineBannerHtml = this.#sessionOptions.mode === MockTestRunner.MODE_OFFLINE
            ? `<div class="mock-test-runner-offline-banner">Offline mode — read each question here and write your answers on paper. Start every answer with its question number on the left (e.g. <strong>1.</strong>, <strong>2.</strong>) so we can match it back. When you finish, tap <strong>Finish Test</strong> and upload photos or a PDF of your sheets.</div>`
            : "";

        this.innerHTML = `
            <div class="mock-test-runner-root">

                <div class="mock-test-runner-sticky-header">
                    <div class="mock-test-runner-header-left">
                        <div class="mock-test-runner-title">${MockTestRunner.#escapeHtml(mockTestTitle)}</div>
                        <div class="mock-test-runner-meta">
                            <span class="mock-test-runner-meta-pill">${modeLabel}</span>
                            <span class="mock-test-runner-meta-pill">${totalMarks} marks</span>
                            <span class="mock-test-runner-meta-pill">${MockTestRunner.#escapeHtml(markingSchemeText)}</span>
                        </div>
                    </div>
                    <div class="mock-test-runner-header-right">
                        <div class="mock-test-runner-timer" aria-label="Time remaining">--:--</div>
                        <button class="mock-test-runner-finish-button" type="button">Finish Test</button>
                    </div>
                </div>

                <div class="mock-test-runner-fullscreen-affordance" hidden>
                    <span>Test is running outside fullscreen.</span>
                    <button class="mock-test-runner-fullscreen-restore-button" type="button">Re-enter Fullscreen</button>
                </div>

                ${offlineBannerHtml}

                <div class="mock-test-runner-items-container"></div>

                <div class="mock-test-runner-upload-pane" hidden>
                    <div class="mock-test-runner-upload-pane-header">Upload your answer sheets</div>
                    <div class="mock-test-runner-upload-pane-description">
                        Upload clear photos or a single PDF of your handwritten sheets, in page order. Make sure each answer's question number (written on the left) is legible — we use it to line your answer up with the right question. You'll get to review and fix the read-back before it's graded.
                    </div>
                    <input
                        type="file"
                        class="mock-test-runner-upload-input"
                        accept="application/pdf,image/*"
                        multiple
                    />
                    <ul class="mock-test-runner-upload-file-list"></ul>
                    <div class="mock-test-runner-upload-actions">
                        <button class="mock-test-runner-upload-submit-button" type="button">Submit Upload</button>
                    </div>
                </div>

            </div>
        `;
    }

    #renderItems()
    {
        const itemsContainer = this.querySelector(".mock-test-runner-items-container");
        if (!itemsContainer)
        {
            return;
        }

        const items = this.#mockTest.getItems() || [];
        let runningQuestionNumber = 0;
        let currentSection = null;
        const isOffline = this.#sessionOptions.mode === MockTestRunner.MODE_OFFLINE;
        const renderedFragments = [];

        for (const item of items)
        {
            const itemType = item.getType();
            if (itemType === mockTestItemTypes.TITLE)
            {
                renderedFragments.push({ html: this.#renderTitleItem(item), questionItem: null });
            }
            else if (itemType === mockTestItemTypes.INSTRUCTIONS)
            {
                renderedFragments.push({ html: this.#renderInstructionsItem(item), questionItem: null });
            }
            else if (itemType === mockTestItemTypes.SECTION)
            {
                currentSection = item;
                renderedFragments.push({ html: this.#renderSectionItem(item), questionItem: null });
            }
            else if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
                renderedFragments.push({ html: this.#renderQuestionItem(item, runningQuestionNumber, isOffline, currentSection), questionItem: item });
            }
        }

        itemsContainer.innerHTML = renderedFragments.map((fragment) => fragment.html).join("");

        // Wire up answer extractors. We do this after innerHTML assignment so
        // the live DOM nodes exist.
        for (const fragment of renderedFragments)
        {
            if (!fragment.questionItem)
            {
                continue;
            }
            const questionElement = itemsContainer.querySelector(`[data-question-id="${fragment.questionItem.getId()}"]`);
            if (!questionElement)
            {
                continue;
            }
            this.#installAnswerExtractor(questionElement, fragment.questionItem, isOffline);
        }
    }

    #renderTitleItem(titleItem)
    {
        const titleText = titleItem.getTitle() || "";
        return `<h2 class="mock-test-runner-title-item">${MockTestRunner.#escapeHtml(titleText)}</h2>`;
    }

    #renderInstructionsItem(instructionsItem)
    {
        const content = instructionsItem.getContent() || "";
        return `
            <div class="mock-test-runner-instructions">
                <div class="mock-test-runner-instructions-label">General Instructions</div>
                <div class="mock-test-runner-instructions-content">${MockTestRunner.#escapeHtml(content)}</div>
            </div>
        `;
    }

    #renderSectionItem(sectionItem)
    {
        const sectionTitle = sectionItem.getTitle ? sectionItem.getTitle() : "";
        const sectionDescription = sectionItem.getDescription ? sectionItem.getDescription() : "";
        return `
            <div class="mock-test-runner-section-banner">
                <div class="mock-test-runner-section-title">${MockTestRunner.#escapeHtml(sectionTitle)}</div>
                ${sectionDescription ? `<div class="mock-test-runner-section-description">${MockTestRunner.#escapeHtml(sectionDescription)}</div>` : ""}
            </div>
        `;
    }

    #renderQuestionItem(questionItem, questionNumber, isOffline, currentSection = null)
    {
        const questionId = questionItem.getId();
        const questionHtml = HtmlSanitizer.sanitize(questionItem.getQuestion() || "");
        const marks = MockTestRunner.#resolveQuestionMarks(this.#mockTest, questionItem, currentSection);
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const resolvedQuestionType = additionalData.type ?? null;

        // Offline mode is question-paper-only: the candidate writes on paper, so
        // no answer inputs are rendered — just the question, marks, and the
        // running timer in the header stay on screen.
        const inputBlockHtml = isOffline
            ? ""
            : `<div class="mock-test-runner-question-input">${this.#renderQuestionInputHtml(questionId, resolvedQuestionType, additionalData, isOffline)}</div>`;

        return `
            <div class="mock-test-runner-question" data-question-id="${MockTestRunner.#escapeHtml(questionId)}">
                <div class="mock-test-runner-question-header">
                    <div class="mock-test-runner-question-number">Q.${questionNumber}</div>
                    <div class="mock-test-runner-question-text">${questionHtml}</div>
                    <div class="mock-test-runner-question-marks">[${marks} M]</div>
                </div>
                ${inputBlockHtml}
            </div>
        `;
    }

    #renderQuestionInputHtml(questionId, questionType, additionalData, isOffline)
    {
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];
        const disabledAttribute = isOffline ? "disabled" : "";

        if (MockTestRunner.OPTION_BASED_QUESTION_TYPES.has(questionType))
        {
            // Always render checkboxes for option-based questions so the
            // input shape does not reveal whether the question is
            // single-correct or multi-correct. Selecting multiple on a
            // single-correct question is the user's mistake to make.
            return `
                <div class="mock-test-runner-options">
                    ${options.map((optionText, optionIndex) => `
                        <label class="mock-test-runner-option">
                            <input
                                type="checkbox"
                                name="question-${MockTestRunner.#escapeHtml(questionId)}"
                                value="${optionIndex}"
                                ${disabledAttribute}
                            />
                            <span class="mock-test-runner-option-label">${MockTestRunner.OPTION_LABELS[optionIndex] || optionIndex + 1}</span>
                            <span class="mock-test-runner-option-text">${MockTestRunner.#escapeHtml(optionText)}</span>
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
                    class="mock-test-runner-objective-input"
                    placeholder="Your answer..."
                    ${disabledAttribute}
                />
            `;
        }

        if (MockTestRunner.SUBJECTIVE_MIN_HEIGHT_PX.has(questionType))
        {
            const minHeightPx = MockTestRunner.SUBJECTIVE_MIN_HEIGHT_PX.get(questionType);
            const disabledOverlayHtml = isOffline
                ? `<div class="mock-test-runner-subjective-disabled-overlay">Write on paper. Inputs are disabled in offline mode.</div>`
                : "";

            return `
                <div class="mock-test-runner-subjective-wrapper" style="min-height:${minHeightPx}px;">
                    <rich-text-editor
                        class="mock-test-runner-subjective-editor"
                        placeholder="Your answer..."
                    ></rich-text-editor>
                    ${disabledOverlayHtml}
                </div>
            `;
        }

        // Fallback for unknown / unspecified question types — a single
        // text input keeps the surface usable rather than crashing.
        return `
            <input
                type="text"
                class="mock-test-runner-objective-input"
                placeholder="Your answer..."
                ${disabledAttribute}
            />
        `;
    }

    #installAnswerExtractor(questionElement, questionItem, isOffline)
    {
        if (isOffline)
        {
            // No on-screen capture for offline mode — the answer lives on paper.
            this.#answerExtractors.set(questionItem.getId(), () => "");
            return;
        }

        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const questionType = additionalData.type ?? null;

        if (MockTestRunner.OPTION_BASED_QUESTION_TYPES.has(questionType))
        {
            // Always JSON-stringified array of indices — the evaluator
            // decides whether single-correct expectations are violated
            // by a length > 1.
            this.#answerExtractors.set(questionItem.getId(), () =>
            {
                const checkedBoxes = questionElement.querySelectorAll('input[type="checkbox"]:checked');
                const selectedIndices = Array.from(checkedBoxes).map((checkbox) => parseInt(checkbox.value, 10));
                return JSON.stringify(selectedIndices);
            });
            return;
        }

        if (questionType === questionTypes.OBJECTIVE_SINGLE_WORD_OR_PHRASE)
        {
            this.#answerExtractors.set(questionItem.getId(), () =>
            {
                const textInput = questionElement.querySelector(".mock-test-runner-objective-input");
                return textInput ? textInput.value.trim() : "";
            });
            return;
        }

        if (MockTestRunner.SUBJECTIVE_MIN_HEIGHT_PX.has(questionType))
        {
            this.#answerExtractors.set(questionItem.getId(), () =>
            {
                const editor = questionElement.querySelector(".mock-test-runner-subjective-editor");
                return editor && typeof editor.getInnerHtml === "function" ? editor.getInnerHtml() : "";
            });
            return;
        }

        // Fallback extractor (matches the fallback input).
        this.#answerExtractors.set(questionItem.getId(), () =>
        {
            const textInput = questionElement.querySelector(".mock-test-runner-objective-input");
            return textInput ? textInput.value.trim() : "";
        });
    }

    #renderLatex()
    {
        const itemsContainer = this.querySelector(".mock-test-runner-items-container");
        if (!itemsContainer || typeof renderMathInElement === "undefined")
        {
            return;
        }

        renderMathInElement(itemsContainer,
        {
            delimiters:
            [
                { left: "\\(", right: "\\)", display: false },
                { left: "\\[", right: "\\]", display: true  }
            ],
            throwOnError: false
        });
    }

    // ── Event wiring ───────────────────────────────────────────────────────────

    #bindUiEvents()
    {
        const finishButton = this.querySelector(".mock-test-runner-finish-button");
        if (finishButton)
        {
            finishButton.addEventListener("click", () => this.#onFinishClicked());
        }

        const restoreFullscreenButton = this.querySelector(".mock-test-runner-fullscreen-restore-button");
        if (restoreFullscreenButton)
        {
            restoreFullscreenButton.addEventListener("click", async () =>
            {
                try { await document.documentElement.requestFullscreen(); }
                catch (fullscreenError) { /* user gesture lost; ignore */ }
            });
        }

        const uploadInput = this.querySelector(".mock-test-runner-upload-input");
        if (uploadInput)
        {
            uploadInput.addEventListener("change", (changeEvent) =>
            {
                this.#pendingUploadFiles = Array.from(changeEvent.target.files || []);
                this.#refreshUploadFileList();
            });
        }

        const uploadSubmitButton = this.querySelector(".mock-test-runner-upload-submit-button");
        if (uploadSubmitButton)
        {
            uploadSubmitButton.addEventListener("click", () => this.#onUploadSubmitClicked());
        }
    }

    async #onFinishClicked()
    {
        if (!this.#isActive)
        {
            return;
        }

        // During a tutorial, skip the "are you sure?" confirm — the guided
        // walkthrough drives Finish itself and a blocking confirm would stall
        // the flow before the demo grading runs.
        if (!TutorialEngine.isRunning())
        {
            const confirmed = await DialogBox.confirm(
                "Finish Test?",
                "Are you sure you want to finish the test now? You will not be able to change your answers after this."
            );
            if (!confirmed)
            {
                return;
            }
        }

        if (this.#sessionOptions.mode === MockTestRunner.MODE_OFFLINE)
        {
            this.#showOfflineUploadPane();
        }
        else
        {
            await this.#performSubmit();
        }
    }

    // ── Timer ──────────────────────────────────────────────────────────────────

    #startTimer(durationSeconds)
    {
        this.#remainingSeconds = durationSeconds;
        this.#updateTimerDisplay();

        this.#timerIntervalHandle = setInterval(() =>
        {
            this.#remainingSeconds -= 1;
            if (this.#remainingSeconds <= 0)
            {
                this.#remainingSeconds = 0;
                this.#updateTimerDisplay();
                this.#onTimerExpired();
                return;
            }
            this.#updateTimerDisplay();
        }, MockTestRunner.TIMER_TICK_INTERVAL_MS);
    }

    #stopTimer()
    {
        if (this.#timerIntervalHandle !== null)
        {
            clearInterval(this.#timerIntervalHandle);
            this.#timerIntervalHandle = null;
        }
    }

    #updateTimerDisplay()
    {
        const timerDisplay = this.querySelector(".mock-test-runner-timer");
        if (!timerDisplay)
        {
            return;
        }
        const minutes = Math.floor(this.#remainingSeconds / 60);
        const seconds = this.#remainingSeconds % 60;
        timerDisplay.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

        if (this.#remainingSeconds <= 60)
        {
            timerDisplay.classList.add("mock-test-runner-timer-critical");
        }
    }

    async #onTimerExpired()
    {
        this.#stopTimer();
        if (!this.#isActive)
        {
            return;
        }

        if (this.#sessionOptions.mode === MockTestRunner.MODE_OFFLINE)
        {
            this.#lockItemsContainer();
            this.#showOfflineUploadPane();
            await DialogBox.alert("Time Up", "Time is up. Please scan and upload your answer sheets below.");
        }
        else
        {
            await DialogBox.alert("Time Up", "Time is up. Submitting your answers.");
            await this.#performSubmit();
        }
    }

    // ── Offline upload flow ────────────────────────────────────────────────────

    #showOfflineUploadPane()
    {
        const uploadPane = this.querySelector(".mock-test-runner-upload-pane");
        if (uploadPane)
        {
            uploadPane.hidden = false;
            uploadPane.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }

    #lockItemsContainer()
    {
        const itemsContainer = this.querySelector(".mock-test-runner-items-container");
        if (itemsContainer)
        {
            itemsContainer.classList.add("mock-test-runner-items-container-locked");
        }
    }

    #refreshUploadFileList()
    {
        const fileList = this.querySelector(".mock-test-runner-upload-file-list");
        if (!fileList)
        {
            return;
        }
        fileList.innerHTML = this.#pendingUploadFiles
            .map((file) => `<li>${MockTestRunner.#escapeHtml(file.name)} <span class="mock-test-runner-upload-file-size">(${MockTestRunner.#formatBytes(file.size)})</span></li>`)
            .join("");
    }

    async #onUploadSubmitClicked()
    {
        if (this.#pendingUploadFiles.length === 0)
        {
            await DialogBox.alert(
                "No files selected",
                "Pick at least one photo or a PDF of your answer sheets before submitting."
            );
            return;
        }

        // The test is over. Tear down the live-test guards exactly like an
        // online submit, then hand the raw scans to the session — it uploads
        // them for transcription and opens the review screen. The answers
        // themselves are on paper, so there is nothing to extract from the DOM.
        const uploadSubmitButton = this.querySelector(".mock-test-runner-upload-submit-button");
        if (uploadSubmitButton)
        {
            uploadSubmitButton.disabled = true;
            uploadSubmitButton.textContent = "Uploading…";
        }

        this.#isActive = false;
        this.#stopTimer();
        this.#removeBackNavigationGuard();
        this.#removeFullscreenWatcher();

        const scanFiles = this.#pendingUploadFiles.slice();
        if (typeof this.#onOfflineSubmitCallback === "function")
        {
            this.#onOfflineSubmitCallback(scanFiles, this.#attemptId);
        }
    }

    /**
     * Public, idempotent teardown. Stops the timer, drops the back-nav
     * and fullscreen guards, exits fullscreen if engaged, and detaches
     * itself from the DOM so disconnectedCallback fires once. Use this
     * when the surrounding page is being left (StudyPage.onPageLeft) or
     * whenever an in-flight attempt must be abandoned without
     * submitting — the user's in-progress answers are intentionally
     * discarded.
     */
    cancel()
    {
        if (!this.#isActive && !this.#timerIntervalHandle && !this.#popstateHandler)
        {
            return;
        }
        this.#isActive = false;
        this.#stopTimer();
        this.#removeBackNavigationGuard();
        this.#removeFullscreenWatcher();
        if (document.fullscreenElement)
        {
            document.exitFullscreen().catch(() => {});
        }
        if (this.parentNode)
        {
            this.parentNode.removeChild(this);
        }
    }

    // ── Submission ─────────────────────────────────────────────────────────────

    async #performSubmit()
    {
        if (!this.#isActive)
        {
            return;
        }

        this.#isActive = false;
        this.#stopTimer();
        this.#removeBackNavigationGuard();
        this.#removeFullscreenWatcher();

        // Deep clone via toJson/fromJson so the live MockTest's items
        // remain untouched — the attempt owns its own copy.
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

        // Online-only path — offline mode never reaches here (it routes through
        // #onUploadSubmitClicked → the offline scan callback instead).
        if (typeof this.#onSubmitCallback === "function")
        {
            this.#onSubmitCallback(clonedItems, null);
        }
    }

    // ── Back-navigation guard ──────────────────────────────────────────────────

    #installBackNavigationGuard()
    {
        // Push a sentinel so the first popstate has something to consume.
        try { history.pushState({ mockTestRunnerSentinel: true }, "", location.href); } catch (pushError) { /* non-fatal */ }

        this.#popstateHandler = (popstateEvent) =>
        {
            if (!this.#isActive)
            {
                return;
            }
            popstateEvent.stopImmediatePropagation();

            DialogBox.confirm(
                "Exit Test?",
                "Your in-progress answers will be lost. Are you sure you want to leave?"
            ).then((confirmed) =>
            {
                if (confirmed)
                {
                    this.#isActive = false;
                    this.#stopTimer();
                    this.#removeBackNavigationGuard();
                    this.#removeFullscreenWatcher();
                    if (document.fullscreenElement)
                    {
                        document.exitFullscreen().catch(() => {});
                    }
                    history.back();
                }
                else
                {
                    try { history.pushState({ mockTestRunnerSentinel: true }, "", location.href); } catch (pushError) { /* non-fatal */ }
                }
            });
        };

        window.addEventListener("popstate", this.#popstateHandler, true);
    }

    #removeBackNavigationGuard()
    {
        if (this.#popstateHandler)
        {
            window.removeEventListener("popstate", this.#popstateHandler, true);
            this.#popstateHandler = null;
        }
    }

    // ── Fullscreen change watcher ──────────────────────────────────────────────

    #installFullscreenWatcher()
    {
        this.#fullscreenChangeHandler = () =>
        {
            this.#refreshFullscreenAffordance();
        };
        document.addEventListener("fullscreenchange", this.#fullscreenChangeHandler);
    }

    #removeFullscreenWatcher()
    {
        if (this.#fullscreenChangeHandler)
        {
            document.removeEventListener("fullscreenchange", this.#fullscreenChangeHandler);
            this.#fullscreenChangeHandler = null;
        }
    }

    #refreshFullscreenAffordance()
    {
        const affordance = this.querySelector(".mock-test-runner-fullscreen-affordance");
        if (!affordance)
        {
            return;
        }
        // During a tutorial fullscreen is intentionally never requested, so the
        // "re-enter fullscreen" prompt would be misleading — keep it hidden.
        affordance.hidden = !!document.fullscreenElement || TutorialEngine.isRunning();
    }

    // ── Static helpers ─────────────────────────────────────────────────────────

    static #computeTotalMarks(mockTest)
    {
        const items = mockTest.getItems ? mockTest.getItems() : [];
        let totalMarks = 0;
        let currentSection = null;
        for (const item of items)
        {
            if (item.getType() === mockTestItemTypes.SECTION)
            {
                currentSection = item;
                continue;
            }
            if (item.getType() === mockTestItemTypes.QUESTION)
            {
                totalMarks += MockTestRunner.#resolveQuestionMarks(mockTest, item, currentSection);
            }
        }
        return totalMarks;
    }

    /**
     * Per-question effective marks. We prefer the marking scheme's resolved
     * correctMarks (honouring section / type overrides) — the question's static
     * `marks` field defaults to 1 when the LLM omits it, which makes the badge
     * and total drift away from what the marking-scheme pill advertises.
     * If a question carries an explicit override (>1), that wins.
     */
    static #resolveQuestionMarks(mockTest, questionItem, sectionItem)
    {
        const staticMarks = Number(questionItem.getMarks ? questionItem.getMarks() : 0) || 0;
        const sectionContext = sectionItem
            ? { id: sectionItem.getId(), label: sectionItem.getTitle ? sectionItem.getTitle() : "" }
            : null;
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const rule = mockTest.resolveMarkingRuleForQuestion
            ? mockTest.resolveMarkingRuleForQuestion({ additionalData }, sectionContext)
            : null;
        const schemeMarks = rule ? (Number(rule.correctMarks) || 0) : 0;
        return staticMarks > 1 ? staticMarks : schemeMarks || staticMarks;
    }

    static #formatMarkingSchemeSummary(mockTest)
    {
        const markingScheme = mockTest.getMarkingScheme ? mockTest.getMarkingScheme() : null;
        if (!markingScheme)
        {
            return "+1 correct, 0 wrong";
        }
        const correctMarks = Number(markingScheme.correctMarks) || 0;
        const wrongMarks = Number(markingScheme.wrongMarks) || 0;
        const correctSign = correctMarks >= 0 ? "+" : "";
        const wrongSign = wrongMarks >= 0 ? "+" : "";
        return `${correctSign}${correctMarks} correct, ${wrongSign}${wrongMarks} wrong`;
    }

    static #formatBytes(byteCount)
    {
        if (!Number.isFinite(byteCount))
        {
            return "";
        }
        if (byteCount < 1024)
        {
            return `${byteCount} B`;
        }
        if (byteCount < 1024 * 1024)
        {
            return `${(byteCount / 1024).toFixed(1)} KB`;
        }
        return `${(byteCount / (1024 * 1024)).toFixed(1)} MB`;
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

customElements.define("mock-test-runner", MockTestRunner);
export default MockTestRunner;
