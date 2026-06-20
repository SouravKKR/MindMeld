import { mockTestItemTypes } from "../../Globals/Enumerations/MockTestItemTypes.js";
import { mockTestEvaluationStatuses } from "../../Globals/Enumerations/MockTestEvaluationStatuses.js";
import { questionTypes } from "../../Globals/Enumerations/QuestionTypes.js";
import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import HtmlSanitizer from "../../Globals/Classes/HtmlSanitizer.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import CreditNotice from "../../Globals/Classes/Credits/CreditNotice.js";
import SyncEvents from "../../Globals/Events/SyncEvents.js";
import Deck from "../../Globals/Model/Deck.js";
import MockTest from "../../Globals/Model/MockTest.js";
import TaskProgressTracker from "../../Globals/Classes/Task/TaskProgressTracker.js";
import CuratedStudyProgressOverlay from "../Study/Components/CuratedStudyProgressOverlay.js";
import EvaluationInstructionsDialog from "../Study/Components/EvaluationInstructionsDialog.js";
import MockTestAnswerKeyPdfBuilder from "./Classes/MockTestAnswerKeyPdfBuilder.js";
import MetricTracker from "../../Globals/Classes/Metrics/MetricTracker.js";


const WAIT_OVERLAY_PHASE_LABELS = Object.freeze({
    queued:               "Evaluation queued…",
    "joined-existing-run":"Joining an in-flight evaluation…",
    progress:             "Grading your answers…",
    "task-terminal":      "Almost done — syncing your scores.",
    "sync-complete":      "Done — refreshing the page.",
});

// Requires: Pages/MockTestAnswerKey/Styles/MockTestAnswerKeyPage.css

/**
 * Full-screen viewer for the answer key of a mock test. Walks the items
 * in order and for every question shows the expected answer (rendered
 * as an option letter when the expected value points at an option),
 * the optional reason, and optional solving steps.
 *
 * When the page is opened with an attempt, it also shows the candidate's
 * submitted answer, the awarded score, and any examiner remarks the LLM
 * grader left for that question. A toolbar at the top lets the user
 * download the entire answer key as a PDF and re-evaluate the attempt
 * (which spawns a fresh evaluation task — the new scores overwrite the
 * old ones when it completes).
 *
 * Opened via PageNavigator.open("mock-test-answer-key-page", mockTest, attempt?).
 */
class MockTestAnswerKeyPage extends HTMLElement
{
    static OPTION_LETTERS_UPPERCASE = ["A", "B", "C", "D", "E", "F", "G", "H"];

    #mockTest = null;
    #attempt = null;
    #boundSyncCompletedHandler = null;
    #waitCancelled = false;
    #backgroundPollCancelled = false;
    #backgroundPollTaskId = null;
    #backgroundPollLatestPercent = 0;

    initialize(mockTest, attempt = null)
    {
        this.#mockTest = mockTest;
        // Default to NO attempt selected — the page opens on the pure
        // answer key (questions + expected answers + reasons). The user
        // explicitly picks an attempt from the dropdown when they want
        // to see their results. Callers that ARE navigating with a
        // specific attempt (e.g. just after submit) still pass it
        // through and it stays selected.
        this.#attempt = attempt;
    }

    disconnectedCallback()
    {
        if (this.#boundSyncCompletedHandler)
        {
            window.removeEventListener(SyncEvents.COMPLETED, this.#boundSyncCompletedHandler);
            this.#boundSyncCompletedHandler = null;
        }
        this.#backgroundPollCancelled = true;
        this.#backgroundPollTaskId = null;
    }

    async connectedCallback()
    {
        if (!this.#mockTest)
        {
            this.innerHTML = `<header-component title="Answer Key"></header-component><div class="mock-test-answer-key-page-empty">No mock test loaded.</div>`;
            return;
        }

        // Materialise plaintext question content for a paid deck before the
        // synchronous render below, so the answer key never shows [Locked]
        // placeholders. No-op for a normal deck; on a locked deck decrypt is a
        // safe no-op (cache stays null) — but every entry point gates the
        // unlock first, so by here the deck is unlocked.
        await this.#mockTest.decryptForStudy();

        // A graded (COMPLETED) attempt is the moment an LLM-graded mock test
        // becomes countable — recompute server-side so its badge is awarded now.
        if (this.#attempt && this.#attempt.getEvaluationStatus?.() === mockTestEvaluationStatuses.COMPLETED)
        {
            MetricTracker.sync({ recompute: true });
        }

        const title = this.#mockTest.getTitle() || "Mock Test";
        const totalMarks = MockTestAnswerKeyPage.#computeTotalMarks(this.#mockTest);
        const attemptStatusBanner = this.#renderStatusBannerHtml();
        const attemptScoreBlock = this.#renderAttemptScoreHtml();
        const attemptHistoryDropdown = this.#renderAttemptHistoryDropdownHtml();
        const reEvaluateButtonHtml = this.#canReEvaluate()
            ? `<button class="mock-test-answer-key-page-reevaluate-button" type="button">Re-evaluate</button>`
            : "";
        const waitButtonHtml = this.#canWaitForEvaluation()
            ? `<button class="mock-test-answer-key-page-wait-button" type="button">Wait for grading</button>`
            : "";
        const deleteAttemptButtonHtml = this.#attempt
            ? `<button class="mock-test-answer-key-page-delete-attempt-button" type="button">Delete attempt</button>`
            : "";

        // A PDF download is an export path, so it is withheld for a paid deck —
        // the answer key can be viewed on-screen but not extracted to a file.
        const bIsPaidDeck = !!this.#mockTest.getDeck?.()?.getAdditionalData?.()?.paidDeckId;
        const downloadButtonHtml = bIsPaidDeck
            ? ""
            : `<button class="mock-test-answer-key-page-download-button" type="button">
                        <img class="mock-test-answer-key-page-download-icon" src="./Globals/Assets/Images/Icons/DownloadIcon.svg" alt="">
                        Download PDF
                    </button>`;

        this.innerHTML = `
            <header-component title="Answer Key: ${MockTestAnswerKeyPage.#escapeHtml(title)}"></header-component>
            <div class="mock-test-answer-key-page-toolbar">
                <div class="mock-test-answer-key-page-toolbar-info">
                    <div class="mock-test-answer-key-page-toolbar-title">${MockTestAnswerKeyPage.#escapeHtml(title)}</div>
                    <div class="mock-test-answer-key-page-toolbar-meta">${totalMarks} marks total</div>
                    ${attemptScoreBlock}
                </div>
                <div class="mock-test-answer-key-page-toolbar-actions">
                    ${attemptHistoryDropdown}
                    ${waitButtonHtml}
                    ${reEvaluateButtonHtml}
                    ${deleteAttemptButtonHtml}
                    ${downloadButtonHtml}
                    <button class="mock-test-answer-key-page-home-button" type="button">Home</button>
                </div>
            </div>
            ${attemptStatusBanner}
            <div class="mock-test-answer-key-page-scrollable">
                <div class="mock-test-answer-key-page-body"></div>
            </div>
        `;

        this.#renderBody();
        this.#bindEvents();
        this.#renderLatex();
        this.#installAutoRefreshListener();
        this.#maybeStartBackgroundProgressPoll();
    }

    /**
     * When an attempt is in GRADING state AND we know its task id,
     * start polling /Generate/Progress in the background and pipe the
     * percentage into the inline progress bar inside the banner. No
     * modal, no blocking — the user keeps the rest of the page usable.
     * Idempotent across re-renders: if a poll is already running for
     * the same task id, we don't start another. Cancelled via
     * disconnectedCallback so navigating away doesn't leave a poll
     * loop running.
     */
    #maybeStartBackgroundProgressPoll()
    {
        if (!this.#attempt || this.#attempt.getEvaluationStatus() !== mockTestEvaluationStatuses.GRADING)
        {
            this.#backgroundPollTaskId = null;
            return;
        }
        const additionalData = this.#attempt.getAdditionalData() || {};
        const taskId = additionalData.evaluationTaskId;
        if (typeof taskId !== "string" || taskId.length === 0)
        {
            return;
        }
        if (this.#backgroundPollTaskId === taskId)
        {
            // Already polling this exact task; just re-paint the bar
            // with whatever percent we last saw so the freshly-rendered
            // banner doesn't reset to 0%.
            this.#paintBackgroundProgressBar(this.#backgroundPollLatestPercent);
            return;
        }
        this.#backgroundPollTaskId = taskId;
        this.#backgroundPollCancelled = false;
        this.#backgroundPollLatestPercent = 0;
        this.#runBackgroundProgressPoll(taskId).catch((pollError) =>
        {
            console.warn("[MockTestAnswerKeyPage] Background progress poll ended with error:", pollError);
        });
    }

    async #runBackgroundProgressPoll(taskId)
    {
        try
        {
            await TaskProgressTracker.trackAndSync(taskId, (statusEvent) =>
            {
                if (this.#backgroundPollCancelled || this.#backgroundPollTaskId !== taskId)
                {
                    return;
                }
                const percent = MockTestAnswerKeyPage.#computeProgressPercentFromStatusEvent(statusEvent);
                if (percent !== null)
                {
                    this.#backgroundPollLatestPercent = percent;
                    this.#paintBackgroundProgressBar(percent);
                }
            });
            if (!this.#backgroundPollCancelled && this.#backgroundPollTaskId === taskId)
            {
                // Sync push completed inside trackAndSync — the
                // SyncEvents.COMPLETED handler we installed will re-look-up
                // the attempt and re-render with scores. Explicitly call
                // it here too in case sync was a no-op.
                this.#backgroundPollTaskId = null;
                // A paid deck's mock test (re-)decrypts its question content into
                // the transient cache before re-rendering, so a fresh instance
                // pulled in by sync never shows locked placeholders. No-op for a
                // normal deck or a locked one.
                await this.#mockTest?.decryptForStudy?.();
                this.connectedCallback();
            }
        }
        catch (pollError)
        {
            if (!this.#backgroundPollCancelled)
            {
                console.warn("[MockTestAnswerKeyPage] Background progress poll threw:", pollError);
            }
        }
    }

    #paintBackgroundProgressBar(percent)
    {
        const clamped = Math.max(0, Math.min(100, Math.round(percent)));
        const fillElement = this.querySelector(".mock-test-answer-key-page-banner-progress-fill");
        const labelElement = this.querySelector(".mock-test-answer-key-page-banner-progress-percent");
        if (fillElement)
        {
            fillElement.style.width = `${clamped}%`;
        }
        if (labelElement)
        {
            labelElement.textContent = `${clamped}%`;
        }
    }

    static #computeProgressPercentFromStatusEvent(statusEvent)
    {
        if (!statusEvent)
        {
            return null;
        }
        if (statusEvent.phase === "sync-complete")
        {
            return 100;
        }
        if (statusEvent.phase === "task-terminal")
        {
            return 95;
        }
        if (statusEvent.phase !== "progress" || !statusEvent.taskTree)
        {
            return null;
        }
        const aggregate = MockTestAnswerKeyPage.#aggregateTreeCompletion(statusEvent.taskTree);
        if (aggregate.nodeCount === 0)
        {
            return null;
        }
        const averageCompletion = aggregate.completionSum / aggregate.nodeCount;
        return Math.max(2, Math.min(90, Math.round(averageCompletion * 90)));
    }

    static #aggregateTreeCompletion(node)
    {
        if (!node)
        {
            return { completionSum: 0, nodeCount: 0 };
        }
        const nodeCompletion = typeof node.completion === "number" && Number.isFinite(node.completion) ? node.completion : 0;
        let completionSum = nodeCompletion;
        let nodeCount = 1;
        const children = Array.isArray(node.children) ? node.children : [];
        for (const childNode of children)
        {
            const childAggregate = MockTestAnswerKeyPage.#aggregateTreeCompletion(childNode);
            completionSum += childAggregate.completionSum;
            nodeCount += childAggregate.nodeCount;
        }
        return { completionSum, nodeCount };
    }

    #installAutoRefreshListener()
    {
        if (this.#boundSyncCompletedHandler)
        {
            return;
        }
        this.#boundSyncCompletedHandler = () => this.#handleSyncCompleted();
        window.addEventListener(SyncEvents.COMPLETED, this.#boundSyncCompletedHandler);
    }

    async #handleSyncCompleted()
    {
        if (!this.#mockTest)
        {
            return;
        }
        // SyncApplier replaces the existing MockTest instance via
        // removeMockTest + addMockTest, so any cached reference goes
        // stale after a pull. Re-look-up the live one before deciding
        // whether to repaint.
        const owningDeck = Deck.getById(this.#mockTest.getDeckId());
        const refreshedMockTest = owningDeck && typeof owningDeck.getMockTests === "function"
            ? owningDeck.getMockTests(false).find(candidate => candidate.getId() === this.#mockTest.getId())
            : null;
        if (!refreshedMockTest)
        {
            return;
        }

        const previousAttemptId = this.#attempt ? this.#attempt.getId() : null;
        const refreshedAttempt = previousAttemptId
            ? (refreshedMockTest.getHistory() || []).find(candidate => candidate.getId() === previousAttemptId)
            : null;

        const previousStatus = this.#attempt ? this.#attempt.getEvaluationStatus() : null;
        const refreshedStatus = refreshedAttempt ? refreshedAttempt.getEvaluationStatus() : null;
        const previousScore = this.#attempt ? this.#attempt.getScore() : null;
        const refreshedScore = refreshedAttempt ? refreshedAttempt.getScore() : null;

        const statusChanged = previousStatus !== refreshedStatus;
        const scoreChanged = previousScore !== refreshedScore;
        const mockTestReferenceChanged = refreshedMockTest !== this.#mockTest;

        if (!statusChanged && !scoreChanged && !mockTestReferenceChanged)
        {
            return;
        }

        this.#mockTest = refreshedMockTest;
        if (refreshedAttempt)
        {
            this.#attempt = refreshedAttempt;
        }
        // A sync pull replaces a paid mock test with a fresh instance whose
        // question content is ciphertext — re-decrypt it into the transient
        // cache before re-rendering so the answer key never shows locked
        // placeholders. No-op for a normal deck or a locked one.
        await this.#mockTest.decryptForStudy();
        // Tear down the previous listener registration; connectedCallback
        // re-installs it.
        if (this.#boundSyncCompletedHandler)
        {
            window.removeEventListener(SyncEvents.COMPLETED, this.#boundSyncCompletedHandler);
            this.#boundSyncCompletedHandler = null;
        }
        this.connectedCallback();
    }

    #renderBody()
    {
        const bodyContainer = this.querySelector(".mock-test-answer-key-page-body");
        if (!bodyContainer)
        {
            return;
        }

        const blueprintItems = this.#mockTest.getItems() || [];
        const gradedQuestionLookup = this.#buildGradedQuestionLookup();

        let runningQuestionNumber = 0;
        let currentSection = null;
        const renderedFragments = [];

        for (const item of blueprintItems)
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
                currentSection = item;
                renderedFragments.push(MockTestAnswerKeyPage.#renderSectionItem(item));
            }
            else if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
                const gradedQuestion = gradedQuestionLookup.get(item.getId()) || null;
                renderedFragments.push(MockTestAnswerKeyPage.#renderQuestionItem(item, runningQuestionNumber, this.#mockTest, currentSection, gradedQuestion));
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
                    MockTestAnswerKeyPdfBuilder.downloadPdf(this.#mockTest, this.#attempt);
                }
                catch (downloadError)
                {
                    console.error("[MockTestAnswerKeyPage] PDF download failed:", downloadError);
                    DialogBox.alert("Download Failed", "Could not generate the answer key PDF. Please try again.");
                }
            });
        }

        const reEvaluateButton = this.querySelector(".mock-test-answer-key-page-reevaluate-button");
        if (reEvaluateButton)
        {
            reEvaluateButton.addEventListener("click", () => this.#startReEvaluation());
        }

        const waitButton = this.querySelector(".mock-test-answer-key-page-wait-button");
        if (waitButton)
        {
            waitButton.addEventListener("click", () => this.#startWaitForEvaluation());
        }

        const deleteAttemptButton = this.querySelector(".mock-test-answer-key-page-delete-attempt-button");
        if (deleteAttemptButton)
        {
            deleteAttemptButton.addEventListener("click", () => this.#deleteCurrentAttempt());
        }

        const homeButton = this.querySelector(".mock-test-answer-key-page-home-button");
        if (homeButton)
        {
            homeButton.addEventListener("click", () => PageNavigator.clearAndOpen("home-page"));
        }

        const attemptSelect = this.querySelector(".mock-test-answer-key-page-attempt-select");
        if (attemptSelect)
        {
            attemptSelect.addEventListener("change", (event) =>
            {
                const selectedAttemptId = event.target.value;
                if (!selectedAttemptId)
                {
                    this.#attempt = null;
                }
                else
                {
                    const nextAttempt = (this.#mockTest.getHistory() || []).find((entry) => entry.getId() === selectedAttemptId) || null;
                    this.#attempt = nextAttempt;
                }
                this.connectedCallback();
            });
        }
    }

    async #startReEvaluation()
    {
        if (!this.#attempt || !this.#mockTest)
        {
            return;
        }

        // Paid-deck mock tests grade through the same pipeline; the server
        // sources/sinks the attempt from the buyer's encrypted per-user entity
        // store (passed via paidDeckId).
        const paidDeckId = this.#mockTest.getDeck()?.getAdditionalData?.()?.paidDeckId || null;

        const isOfflineOnlyCandidate = this.#attemptIsOfflineOnly();
        const dialogResult = await EvaluationInstructionsDialog.open({
            initialInstructions: this.#attempt.getEvaluationInstructions() || "",
            initialEnableLlmMcqFeedback: this.#attempt.getEnableLlmMcqFeedback() === true,
            isOfflineOnly: isOfflineOnlyCandidate,
            title: "Re-evaluate Attempt",
            confirmLabel: "Re-evaluate"
        });

        if (!dialogResult.confirmed)
        {
            return;
        }

        this.#attempt.setEvaluationInstructions(dialogResult.instructions);
        this.#attempt.setEnableLlmMcqFeedback(dialogResult.enableLlmMcqFeedback === true);

        // Mirror the submit-flow rule: even an MCQ-only paper goes to
        // the server when the candidate opted in to LLM feedback.
        const shouldRunInlineOfflineGrading = isOfflineOnlyCandidate && dialogResult.enableLlmMcqFeedback !== true;

        if (shouldRunInlineOfflineGrading)
        {
            this.#attempt.evaluate(this.#mockTest);
            this.#attempt.setEvaluationStatus(mockTestEvaluationStatuses.COMPLETED);
            try { await this.#mockTest.save(); } catch (saveError) { console.error("[MockTestAnswerKeyPage] Failed to save re-graded offline attempt:", saveError); }
            this.connectedCallback();
            return;
        }

        this.#attempt.setEvaluationStatus(mockTestEvaluationStatuses.GRADING);
        try { await this.#mockTest.save(); } catch (saveError) { console.error("[MockTestAnswerKeyPage] Failed to save attempt pre-reevaluation:", saveError); }

        // Force a sync BEFORE the POST so any local mutations (the new
        // evaluation status, instructions, mcq-feedback flag) are
        // already in Mongo when the Dock endpoint reads them back. The
        // POST otherwise races the sync push and can land on a stale
        // mockTest snapshot.
        try
        {
            await TaskProgressTracker.triggerSync();
        }
        catch (preEvaluationSyncError)
        {
            console.warn("[MockTestAnswerKeyPage] Pre-reevaluation sync push failed; attempting POST anyway:", preEvaluationSyncError);
        }

        try
        {
            const evaluationResponse = await fetch("/MockTest/EvaluateAttempt", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mockTestId: this.#mockTest.getId(),
                    attemptId: this.#attempt.getId(),
                    evaluationInstructions: dialogResult.instructions,
                    enableLlmMcqFeedback: dialogResult.enableLlmMcqFeedback === true,
                    // Paid decks route grading through the buyer's encrypted
                    // per-user entity store on the server.
                    paidDeckId: paidDeckId,
                    // Send the attempt JSON so the Dock can proceed even
                    // when the pre-evaluation sync push hasn't fully
                    // landed yet in Mongo.
                    attemptSnapshot: this.#attempt.toJson()
                })
            });

            if (evaluationResponse.status === 402)
            {
                const insufficientDetail = await evaluationResponse.json().catch(() => ({}));
                this.#attempt.setEvaluationStatus(mockTestEvaluationStatuses.FAILED);
                try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }
                await CreditNotice.showInsufficientCredits(insufficientDetail);
                this.connectedCallback();
                return;
            }

            if (!evaluationResponse.ok)
            {
                const errorBody = await evaluationResponse.text().catch(() => "");
                throw new Error(`Server returned ${evaluationResponse.status}${errorBody ? ` — ${errorBody}` : ""}`);
            }

            const responseBody = await evaluationResponse.json().catch(() => ({}));
            if (responseBody && typeof responseBody.taskId === "string" && responseBody.taskId.length > 0)
            {
                const previousAdditional = this.#attempt.getAdditionalData() || {};
                this.#attempt.setAdditionalData({ ...previousAdditional, evaluationTaskId: responseBody.taskId });
                try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }
            }
        }
        catch (requestError)
        {
            console.error("[MockTestAnswerKeyPage] Failed to start re-evaluation:", requestError);
            this.#attempt.setEvaluationStatus(mockTestEvaluationStatuses.FAILED);
            try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }
            await DialogBox.alert(
                "Re-evaluation failed",
                `The evaluation server returned an error: ${requestError?.message || "unknown"}. Try again later.`
            );
        }

        this.connectedCallback();
    }

    async #deleteCurrentAttempt()
    {
        if (!this.#attempt || !this.#mockTest)
        {
            return;
        }

        const attemptDate = this.#attempt.getAttemptDate ? this.#attempt.getAttemptDate() : null;
        const attemptLabel = attemptDate ? attemptDate.toLocaleString() : "this attempt";
        const confirmed = await DialogBox.confirm(
            "Delete attempt",
            `Are you sure you want to delete the attempt from ${MockTestAnswerKeyPage.#escapeHtml(attemptLabel)}?<br><br>This action cannot be undone.`
        );

        if (!confirmed)
        {
            return;
        }

        // Cancel any in-flight background progress polling for the
        // attempt we're about to drop so it doesn't try to re-render
        // against a stale reference after removal.
        this.#backgroundPollCancelled = true;
        this.#backgroundPollTaskId = null;

        const removed = this.#mockTest.removeAttempt(this.#attempt);
        if (!removed)
        {
            await DialogBox.alert("Delete attempt", "Could not find that attempt to delete.");
            return;
        }

        try
        {
            await this.#mockTest.save();
        }
        catch (saveError)
        {
            console.error("[MockTestAnswerKeyPage] Failed to save mock test after deleting attempt:", saveError);
            await DialogBox.alert("Delete attempt", "The attempt was removed locally but couldn't be saved. Try again.");
        }

        this.#attempt = null;
        this.connectedCallback();
    }

    #canWaitForEvaluation()
    {
        if (!this.#attempt)
        {
            return false;
        }
        if (this.#attempt.getEvaluationStatus() !== mockTestEvaluationStatuses.GRADING)
        {
            return false;
        }
        const additionalData = this.#attempt.getAdditionalData() || {};
        return typeof additionalData.evaluationTaskId === "string" && additionalData.evaluationTaskId.length > 0;
    }

    async #startWaitForEvaluation()
    {
        if (!this.#canWaitForEvaluation())
        {
            return;
        }
        const taskId = this.#attempt.getAdditionalData().evaluationTaskId;
        this.#waitCancelled = false;

        const overlayHandle = CuratedStudyProgressOverlay.show({
            title: "Evaluating your attempt…",
            statusText: "Querying task…",
            phaseLabels: WAIT_OVERLAY_PHASE_LABELS,
            onCancel: () => { this.#waitCancelled = true; },
        });

        try
        {
            await TaskProgressTracker.trackAndSync(taskId, (statusEvent) =>
            {
                if (!this.#waitCancelled)
                {
                    overlayHandle.updateStatus(statusEvent);
                }
            });

            if (!this.#waitCancelled)
            {
                overlayHandle.close();
                // The sync-completed listener above will already have
                // refreshed the page in most cases, but call
                // connectedCallback() explicitly in case the sync was a
                // no-op (e.g. server-side post-task hook already
                // applied + the cycle pulled nothing for this user).
                this.connectedCallback();
            }
        }
        catch (trackError)
        {
            console.error("[MockTestAnswerKeyPage] Wait-for-grading failed:", trackError);
            overlayHandle.showError("Evaluation didn't finish", trackError?.message || "Try again later.");
        }
    }

    #attemptIsOfflineOnly()
    {
        if (!this.#attempt)
        {
            return true;
        }
        const offlineGradableTypeKeys = new Set(["MULTIPLE_CHOICE", "MULTIPLE_CORRECT"]);
        for (const item of this.#attempt.getItems() || [])
        {
            if (!item || item.getType?.() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            const additionalData = item.getAdditionalData ? item.getAdditionalData() : {};
            const typeKey = MockTestAnswerKeyPage.#resolveTypeKey(additionalData);
            if (!typeKey)
            {
                continue;
            }
            if (!offlineGradableTypeKeys.has(typeKey))
            {
                return false;
            }
        }
        return true;
    }

    #canReEvaluate()
    {
        if (!this.#attempt)
        {
            return false;
        }
        return this.#attempt.getEvaluationStatus() !== mockTestEvaluationStatuses.GRADING;
    }

    #renderStatusBannerHtml()
    {
        if (!this.#attempt)
        {
            return "";
        }
        const status = this.#attempt.getEvaluationStatus();
        if (status === mockTestEvaluationStatuses.GRADING)
        {
            const initialPercent = Math.max(0, Math.min(100, Math.round(this.#backgroundPollLatestPercent)));
            return `
                <div class="mock-test-answer-key-page-banner mock-test-answer-key-page-banner-info">
                    <div class="mock-test-answer-key-page-banner-progress-line">
                        <span class="mock-test-answer-key-page-banner-progress-label">Grading in progress…</span>
                        <span class="mock-test-answer-key-page-banner-progress-percent">${initialPercent}%</span>
                    </div>
                    <div class="mock-test-answer-key-page-banner-progress-track">
                        <div class="mock-test-answer-key-page-banner-progress-fill" style="width: ${initialPercent}%;"></div>
                    </div>
                </div>`;
        }
        if (status === mockTestEvaluationStatuses.PENDING)
        {
            return `<div class="mock-test-answer-key-page-banner mock-test-answer-key-page-banner-info">This attempt hasn't been graded yet. Click "Re-evaluate" to grade it now.</div>`;
        }
        if (status === mockTestEvaluationStatuses.FAILED)
        {
            return `<div class="mock-test-answer-key-page-banner mock-test-answer-key-page-banner-warning">Evaluation failed. Click "Re-evaluate" to retry.</div>`;
        }
        if (status === mockTestEvaluationStatuses.COMPLETED)
        {
            const additionalData = this.#attempt.getAdditionalData ? this.#attempt.getAdditionalData() : {};
            const failedQuestionCount = Number.isFinite(additionalData.evaluationFailedQuestionCount) ? additionalData.evaluationFailedQuestionCount : 0;
            if (failedQuestionCount > 0)
            {
                return `<div class="mock-test-answer-key-page-banner mock-test-answer-key-page-banner-warning">The grader could not score ${failedQuestionCount} question(s) — those answers appear with score 0 below but were not actually evaluated. This is a server-side LLM failure, not a candidate failure. Click "Re-evaluate" to re-grade the entire attempt, or check the task log for diagnostics.</div>`;
            }
        }
        return "";
    }

    #renderAttemptScoreHtml()
    {
        if (!this.#attempt || this.#attempt.getEvaluationStatus() !== mockTestEvaluationStatuses.COMPLETED)
        {
            return "";
        }
        // Compute the header total by SUMMING the per-question scores
        // and marks on the attempt's items. This always agrees with the
        // per-question rows the user sees below, and side-steps any
        // race where the attempt-level `score` / `maxScore` fields lag
        // behind the per-item scores after a Mongo write + sync pull.
        const { score, maxScore } = MockTestAnswerKeyPage.#sumAttemptScoreFromItems(this.#attempt);
        return `<div class="mock-test-answer-key-page-toolbar-score">Score: <strong>${MockTestAnswerKeyPage.#formatScore(score)}</strong> / ${MockTestAnswerKeyPage.#formatScore(maxScore)}</div>`;
    }

    static #sumAttemptScoreFromItems(attempt)
    {
        let score = 0;
        let maxScore = 0;
        for (const item of attempt.getItems() || [])
        {
            if (item?.getType?.() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            const itemScore = item.getScore ? item.getScore() : 0;
            const itemMarks = item.getMarks ? item.getMarks() : 0;
            score += Number.isFinite(itemScore) ? itemScore : 0;
            maxScore += Number.isFinite(itemMarks) ? itemMarks : 0;
        }
        return { score, maxScore };
    }

    #renderAttemptHistoryDropdownHtml()
    {
        const history = this.#mockTest.getHistory ? this.#mockTest.getHistory() : [];
        if (!Array.isArray(history) || history.length === 0)
        {
            return "";
        }
        const selectedAttemptId = this.#attempt ? this.#attempt.getId() : "";
        const defaultOption = `<option value=""${selectedAttemptId === "" ? " selected" : ""}>— Answer key only (no attempt) —</option>`;
        const attemptOptions = history.map((historicalAttempt) =>
        {
            const attemptId = historicalAttempt.getId();
            const attemptDate = historicalAttempt.getAttemptDate();
            const label = attemptDate ? attemptDate.toLocaleString() : attemptId;
            const selectedAttribute = attemptId === selectedAttemptId ? " selected" : "";
            return `<option value="${MockTestAnswerKeyPage.#escapeHtml(attemptId)}"${selectedAttribute}>${MockTestAnswerKeyPage.#escapeHtml(label)}</option>`;
        }).join("");
        return `<select class="mock-test-answer-key-page-attempt-select">${defaultOption}${attemptOptions}</select>`;
    }

    #buildGradedQuestionLookup()
    {
        const lookup = new Map();
        if (!this.#attempt || this.#attempt.getEvaluationStatus() !== mockTestEvaluationStatuses.COMPLETED)
        {
            return lookup;
        }
        for (const item of this.#attempt.getItems() || [])
        {
            if (item?.getType?.() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            lookup.set(item.getId(), {
                userAnswer: item.getAnswer ? item.getAnswer() : "",
                score: item.getScore ? item.getScore() : 0,
                remarks: item.getRemarks ? item.getRemarks() : ""
            });
        }
        return lookup;
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

    static #renderQuestionItem(questionItem, questionNumber, mockTest = null, sectionItem = null, gradedQuestion = null)
    {
        const questionHtml = HtmlSanitizer.sanitize(questionItem.getQuestion() || "");
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];
        const marks = MockTestAnswerKeyPage.#resolveQuestionMarks(mockTest, questionItem, sectionItem);
        const expectedAnswerRaw = questionItem.getExpectedAnswer ? questionItem.getExpectedAnswer() : "";
        const answerReason = questionItem.getAnswerReason ? questionItem.getAnswerReason() : "";
        const solvingSteps = questionItem.getSolvingSteps ? questionItem.getSolvingSteps() : "";

        const expectedAnswerDisplay = MockTestAnswerKeyPage.formatExpectedAnswer(expectedAnswerRaw, options);

        const userSelectedIndexSet = gradedQuestion ? MockTestAnswerKeyPage.#decodeUserAnswerIndexSet(gradedQuestion.userAnswer, options.length) : new Set();

        const optionsHtml = options.length > 0
            ? `<div class="mock-test-answer-key-options">
                ${options.map((optionText, optionIndex) =>
                {
                    const optionLetter = MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE[optionIndex] || `${optionIndex + 1}`;
                    const isCorrect = MockTestAnswerKeyPage.#isCorrectOptionIndex(expectedAnswerRaw, optionIndex);
                    const isUserSelected = userSelectedIndexSet.has(optionIndex);
                    const correctClass = isCorrect ? " mock-test-answer-key-option-correct" : "";
                    const userClass = isUserSelected ? " mock-test-answer-key-option-user-selected" : "";
                    return `
                        <div class="mock-test-answer-key-option${correctClass}${userClass}">
                            <span class="mock-test-answer-key-option-label">${optionLetter}</span>
                            <span class="mock-test-answer-key-option-text">${MockTestAnswerKeyPage.#escapeHtml(optionText)}</span>
                        </div>
                    `;
                }).join("")}
            </div>`
            : "";

        const isOptionBased = options.length > 0;
        const userAnswerDisplay = gradedQuestion ? MockTestAnswerKeyPage.#formatUserAnswerDisplay(gradedQuestion.userAnswer, options) : "";
        // For option-based questions the user answer is just an option
        // letter (e.g. "B"); render it as plain escaped text so it sits
        // on the same baseline as the expected-answer rendering below
        // (which is also plain escaped text). For subjective questions
        // the answer is HTML from the rich-text editor and must render
        // as HTML.
        const userAnswerInner = gradedQuestion && gradedQuestion.userAnswer
            ? (isOptionBased
                ? MockTestAnswerKeyPage.#escapeHtml(userAnswerDisplay)
                : MockTestAnswerKeyPage.#renderRichContent(userAnswerDisplay))
            : "— left blank —";
        const userAnswerHtml = gradedQuestion
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Your Answer</div>
                <div class="mock-test-answer-key-row-value ${gradedQuestion.userAnswer ? "" : "mock-test-answer-key-row-missing-value"}">
                    ${userAnswerInner}
                </div>
            </div>`
            : "";

        const expectedAnswerHtml = `
            <div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Expected Answer</div>
                <div class="mock-test-answer-key-row-value ${expectedAnswerDisplay ? "" : "mock-test-answer-key-row-missing-value"}">
                    ${expectedAnswerDisplay ? MockTestAnswerKeyPage.#escapeHtml(expectedAnswerDisplay) : "— not provided —"}
                </div>
            </div>`;

        const scoreHtml = gradedQuestion
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Score</div>
                <div class="mock-test-answer-key-row-value">${MockTestAnswerKeyPage.#formatScore(gradedQuestion.score)} / ${marks}</div>
            </div>`
            : "";

        const remarksHtml = gradedQuestion && gradedQuestion.remarks && String(gradedQuestion.remarks).trim().length > 0
            ? `<div class="mock-test-answer-key-row mock-test-answer-key-row-remarks">
                <div class="mock-test-answer-key-row-label">Examiner's Note</div>
                <div class="mock-test-answer-key-row-value">${MockTestAnswerKeyPage.#renderRichContent(gradedQuestion.remarks)}</div>
            </div>`
            : "";

        const reasonHtml = answerReason
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Reason</div>
                <div class="mock-test-answer-key-row-value">${MockTestAnswerKeyPage.#renderRichContent(answerReason)}</div>
            </div>`
            : "";

        const solvingStepsHtml = solvingSteps
            ? `<div class="mock-test-answer-key-row">
                <div class="mock-test-answer-key-row-label">Solving Steps</div>
                <div class="mock-test-answer-key-row-value mock-test-answer-key-solving-steps">${MockTestAnswerKeyPage.#renderRichContent(solvingSteps)}</div>
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
                    ${userAnswerHtml}
                    ${expectedAnswerHtml}
                    ${scoreHtml}
                    ${remarksHtml}
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

        // MULTIPLE_CORRECT answers arrive as a JSON-stringified array of
        // option indices (e.g. "[0, 2]"). Decode that into option letters
        // directly — the comma/whitespace tokeniser below would otherwise
        // split it into "[0" / "2]" and resolve neither, leaving the raw
        // "[0, 2]" on screen instead of "A, C".
        if (trimmedValue.startsWith("["))
        {
            try
            {
                const parsedIndices = JSON.parse(trimmedValue);
                if (Array.isArray(parsedIndices))
                {
                    const letters = parsedIndices
                        .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry < optionsArray.length)
                        .map((entry) => MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE[entry]);
                    if (letters.length > 0)
                    {
                        return letters.join(", ");
                    }
                }
            }
            catch (parseError)
            {
                // Not valid JSON — fall through to the token-based decoder.
            }
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

        const anyResolved = renderedTokens.some((rendered, index) => rendered !== tokens[index]);
        if (anyResolved)
        {
            return renderedTokens.join(", ");
        }
        return trimmedValue;
    }

    static #formatUserAnswerDisplay(rawValue, optionsArray)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return "";
        }
        const text = String(rawValue);
        const hasOptions = Array.isArray(optionsArray) && optionsArray.length > 0;
        if (!hasOptions)
        {
            return text;
        }
        try
        {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed))
            {
                const letters = parsed
                    .filter((entry) => Number.isFinite(entry))
                    .map((entry) => MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE[entry] || String(entry));
                return letters.join(", ");
            }
        }
        catch (parseError)
        {
            // Plain text — fall through.
        }
        return text;
    }

    static #decodeUserAnswerIndexSet(rawValue, optionsLength)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return new Set();
        }
        const text = String(rawValue).trim();
        if (text.length === 0)
        {
            return new Set();
        }
        try
        {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed))
            {
                return new Set(parsed.filter((entry) => Number.isFinite(entry) && entry >= 0 && entry < optionsLength));
            }
        }
        catch (parseError)
        {
            // Fall through.
        }
        return new Set();
    }

    static #tokenToOptionLetter(token, optionsLength)
    {
        const cleaned = token.replace(/[()\[\]\s]/g, "");
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
            const cleaned = token.replace(/[()\[\]\s]/g, "");
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
                totalMarks += MockTestAnswerKeyPage.#resolveQuestionMarks(mockTest, item, currentSection);
            }
        }
        return totalMarks;
    }

    static #resolveQuestionMarks(mockTest, questionItem, sectionItem)
    {
        const staticMarks = Number(questionItem.getMarks ? questionItem.getMarks() : 0) || 0;
        if (!mockTest || !mockTest.resolveMarkingRuleForQuestion)
        {
            return staticMarks;
        }
        const sectionContext = sectionItem
            ? { id: sectionItem.getId(), label: sectionItem.getTitle ? sectionItem.getTitle() : "" }
            : null;
        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const rule = mockTest.resolveMarkingRuleForQuestion({ additionalData }, sectionContext);
        const schemeMarks = rule ? (Number(rule.correctMarks) || 0) : 0;
        return staticMarks > 1 ? staticMarks : schemeMarks || staticMarks;
    }

    static #latestCompletedAttempt(mockTest)
    {
        const history = mockTest && mockTest.getHistory ? mockTest.getHistory() : [];
        if (!Array.isArray(history) || history.length === 0)
        {
            return null;
        }
        const sortedDescending = [...history].sort((leftAttempt, rightAttempt) =>
        {
            const leftDate = leftAttempt.getAttemptDate ? leftAttempt.getAttemptDate().getTime() : 0;
            const rightDate = rightAttempt.getAttemptDate ? rightAttempt.getAttemptDate().getTime() : 0;
            return rightDate - leftDate;
        });
        return sortedDescending[0] || null;
    }

    static #resolveTypeKey(additionalData)
    {
        if (typeof additionalData.typeKey === "string" && additionalData.typeKey.length > 0)
        {
            return additionalData.typeKey;
        }
        // LLM-generated questions only set `additionalData.type` (the
        // integer enum value), not `typeKey`. Fall back to the int and
        // reverse-look-up the enum name so a SHORT_SUBJECTIVE question
        // (type=3, no typeKey) is correctly identified — otherwise
        // #attemptIsOfflineOnly silently skips it and misclassifies the
        // entire attempt as offline-only, sending re-evaluation down
        // the inline deterministic path with no Agent task spawned.
        if (Number.isFinite(additionalData.type))
        {
            for (const candidateKey of Object.keys(questionTypes))
            {
                if (questionTypes[candidateKey] === additionalData.type)
                {
                    return candidateKey;
                }
            }
        }
        return null;
    }

    static #formatScore(value)
    {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue))
        {
            return "0";
        }
        return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(2);
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

    static #renderRichContent(value)
    {
        if (value === null || value === undefined)
        {
            return "";
        }

        const text = String(value);

        if (/<[a-zA-Z]/.test(text))
        {
            // Already-HTML branch: this is LLM-generated / user-authored
            // rich content (examiner remarks, answer reasons, solving steps,
            // subjective answers) and must never reach innerHTML raw — route
            // it through the sanitiser to strip scripts / handlers / unsafe
            // URLs while keeping the formatting.
            return HtmlSanitizer.sanitize(text);
        }

        const escaped = text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

        return `<p>${escaped.replace(/\n/g, "<br>")}</p>`;
    }
}

customElements.define("mock-test-answer-key-page", MockTestAnswerKeyPage);
export default MockTestAnswerKeyPage;
