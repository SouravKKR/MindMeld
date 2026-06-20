import { mockTestItemTypes } from "../../../Globals/Enumerations/MockTestItemTypes.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import { mockTestEvaluationStatuses } from "../../../Globals/Enumerations/MockTestEvaluationStatuses.js";
import MockTestEvaluationConstants from "../../../Globals/Constants/MockTestEvaluationConstants.js";
import sanitizeForJsPdf from "../../../Globals/UtilityFunctions/SanitizeForJsPdf.js";
import StudySession from "./StudySession.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import CreditNotice from "../../../Globals/Classes/Credits/CreditNotice.js";
import TaskProgressTracker from "../../../Globals/Classes/Task/TaskProgressTracker.js";
import MockTestAttempt from "../../../Globals/Model/MockTestEntities/MockTestAttempt.js";
import MockTestItemFactory from "../../../Globals/Model/MockTestEntities/MockTestItemFactory.js";
import MetricTracker from "../../../Globals/Classes/Metrics/MetricTracker.js";
import EvaluationInstructionsDialog from "../Components/EvaluationInstructionsDialog.js";
import "../Components/MockTestRunner.js";

class MockTestSession extends StudySession
{
    static MODE_ONLINE = "online";
    static MODE_OFFLINE = "offline";

    // Blank answer lines to draw per question type for subjective questions.
    // MCQ types (MULTIPLE_CHOICE, MULTIPLE_CORRECT) are handled separately
    // via options rendering and are not present in this map.
    static #blankLinesByQuestionType = new Map
    ([
        [questionTypes.OBJECTIVE_SINGLE_WORD_OR_PHRASE, 1],
        [questionTypes.SHORT_SUBJECTIVE,                3],
        [questionTypes.MEDIUM_SUBJECTIVE,               6],
        [questionTypes.LONG_SUBJECTIVE,                 10],
        [questionTypes.VERY_LONG_SUBJECTIVE,            14],
    ]);

    #mockTest = null;
    #sessionOptions = null;

    /**
     * @param {StudyPage|null} studyPage
     * @param {MockTest} mockTest
     * @param {{mode: string, durationMinutes: number}|null} sessionOptions
     *     null when called from the static PDF helpers (no live session).
     */
    constructor(studyPage, mockTest, sessionOptions = null)
    {
        super(studyPage, null); // no deck — mock tests are standalone
        this.#mockTest = mockTest;
        this.#sessionOptions = sessionOptions || MockTestSession.#deriveDefaultSessionOptions(mockTest);
    }

    static #deriveDefaultSessionOptions(mockTest)
    {
        const declaredDuration = mockTest && mockTest.getDuration ? mockTest.getDuration() : 0;
        return {
            mode: MockTestSession.MODE_ONLINE,
            durationMinutes: declaredDuration > 0 ? declaredDuration : 60
        };
    }

    getMockTest() { return this.#mockTest; }
    getSessionOptions() { return this.#sessionOptions; }
    getMode() { return this.#sessionOptions.mode; }
    getDurationMinutes() { return this.#sessionOptions.durationMinutes; }
    isPreviewMode() { return this.#sessionOptions.bPreview === true; }

    // ── Static PDF utilities ───────────────────────────────────────────────────

    /**
     * Builds a jsPDF document for the given mock test asynchronously, yielding
     * to the event loop between items so the caller's loading UI can repaint
     * and surface progress. Reports `progressCallback(completed, total)` after
     * each item is rendered.
     * @param {MockTest} mockTest
     * @param {(completed: number, total: number) => void} [progressCallback]
     * @returns {Promise<Blob>}
     */
    static async buildPdfBlobAsync(mockTest, progressCallback = null)
    {
        const temporarySession = new MockTestSession(null, mockTest);
        const pdfDocument = await temporarySession.#buildPdf(progressCallback);
        return pdfDocument.output("blob");
    }

    /**
     * Builds a jsPDF document for the given mock test and triggers a download.
     * Can be called without a StudyPage instance.
     * @param {MockTest} mockTest
     * @returns {Promise<void>}
     */
    static async downloadPdf(mockTest)
    {
        const temporarySession = new MockTestSession(null, mockTest);
        const pdfDocument = await temporarySession.#buildPdf();
        pdfDocument.save(`${mockTest.getTitle() || "Mock Test"}.pdf`);
    }

    // ── Required by StudySession interface ────────────────────────────────────

    start()
    {
        if (!this._studyPage)
        {
            return;
        }

        const runnerHostContainer = this._studyPage.querySelector(".mock-test-container");
        if (!runnerHostContainer)
        {
            return;
        }

        const mockTestRunner = document.createElement("mock-test-runner");
        mockTestRunner.initialize(
            this.#mockTest,
            this.#sessionOptions,
            (clonedItems, additionalData) => this.#handleSubmit(clonedItems, additionalData)
        );
        runnerHostContainer.appendChild(mockTestRunner);
    }

    next() { /* not applicable for mock tests */ }

    /**
     * Tears down the mounted MockTestRunner so the in-flight attempt is
     * abandoned without auto-submitting. Called by StudyPage.onPageLeft
     * whenever the user navigates away (header back arrow, PageNavigator
     * back, or any other off-page path the popstate guard inside the
     * runner does not see). The user's in-progress answers are
     * intentionally discarded — there is no "draft autosave" on mock
     * tests.
     */
    stop()
    {
        if (!this._studyPage)
        {
            return;
        }
        const runnerElement = this._studyPage.querySelector("mock-test-runner");
        if (runnerElement && typeof runnerElement.cancel === "function")
        {
            runnerElement.cancel();
        }
    }

    /**
     * Persists a completed attempt to the mock test's history, exits
     * fullscreen, and navigates back. Evaluation is intentionally a
     * TODO — answers (and any offline scan upload paths) are stored
     * on the attempt for the future OCR + LLM evaluation pipeline.
     *
     * In preview mode (started from the editor's Preview button) the
     * attempt is neither created nor saved — the runner just closes —
     * so the in-memory transient MockTest used by the editor never
     * touches storage or the deck's mock-test list.
     */
    async #handleSubmit(clonedItems, additionalData)
    {
        if (this.isPreviewMode())
        {
            if (document.fullscreenElement)
            {
                try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
            }
            PageNavigator.back();
            return;
        }

        const maxScore = MockTestSession.#computeMaxScore(clonedItems);
        const attempt = new MockTestAttempt(undefined, new Date(), clonedItems, 0, maxScore);
        if (additionalData)
        {
            attempt.setAdditionalData(additionalData);
        }

        // Paid-deck mock tests grade through the SAME pipeline, but the server
        // sources/sinks the attempt from the buyer's encrypted per-user entity
        // store (passed via paidDeckId) instead of the plaintext collection.
        const paidDeckId = this.#mockTest.getDeck()?.getAdditionalData?.()?.paidDeckId || null;

        const isOfflineOnlyCandidate = MockTestSession.#attemptIsOfflineOnly(clonedItems);
        const dialogResult = await EvaluationInstructionsDialog.open({
            initialInstructions: "",
            initialEnableLlmMcqFeedback: false,
            isOfflineOnly: isOfflineOnlyCandidate,
            title: "Submit & Evaluate",
            confirmLabel: "Submit"
        });

        if (!dialogResult.confirmed)
        {
            return;
        }

        attempt.setEvaluationInstructions(dialogResult.instructions);
        attempt.setEnableLlmMcqFeedback(dialogResult.enableLlmMcqFeedback === true);

        // Mock tests are counted server-side from COMPLETED attempts (15-min
        // spaced) — not at submit. Offline grading completes synchronously below,
        // so trigger a recompute then; LLM-graded attempts are counted on a later
        // sync (answer-key view / login) once the server marks them COMPLETED.

        // Even an MCQ-only paper goes to the server when the candidate
        // opted in to LLM feedback — that's the only way to get remarks
        // on a deterministically-scored attempt.
        const shouldRunInlineOfflineGrading = isOfflineOnlyCandidate && dialogResult.enableLlmMcqFeedback !== true;

        if (shouldRunInlineOfflineGrading)
        {
            attempt.evaluate(this.#mockTest);
            attempt.setEvaluationStatus(mockTestEvaluationStatuses.COMPLETED);
            this.#mockTest.addAttempt(attempt);
            try
            {
                await this.#mockTest.save();
            }
            catch (saveError)
            {
                console.error("[MockTestSession] Failed to persist offline-graded attempt:", saveError);
            }

            // Offline attempt is COMPLETED + saved — recompute counts it.
            MetricTracker.sync({ recompute: true });

            if (document.fullscreenElement)
            {
                try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
            }

            await DialogBox.alert(
                "Submitted",
                `Your attempt was graded offline. Score: ${attempt.getScore()} / ${attempt.getMaxScore()}.`
            );
            PageNavigator.clearAndOpen("mock-test-answer-key-page", this.#mockTest, attempt);
            return;
        }

        attempt.setEvaluationStatus(mockTestEvaluationStatuses.GRADING);
        this.#mockTest.addAttempt(attempt);
        try
        {
            await this.#mockTest.save();
        }
        catch (saveError)
        {
            console.error("[MockTestSession] Failed to persist attempt before LLM evaluation:", saveError);
        }

        // Force a sync BEFORE the POST so the just-added attempt is
        // visible in Mongo when the Dock endpoint looks it up. Without
        // this, the endpoint reads an old mockTest snapshot that doesn't
        // contain the new attempt and returns 404 — the browser then
        // surfaces a misleading "Could not reach the evaluation server"
        // message even though the server replied just fine.
        try
        {
            await TaskProgressTracker.triggerSync();
        }
        catch (preEvaluationSyncError)
        {
            console.warn("[MockTestSession] Pre-evaluation sync push failed; attempting POST anyway:", preEvaluationSyncError);
        }

        try
        {
            const evaluationResponse = await fetch("/MockTest/EvaluateAttempt", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    mockTestId: this.#mockTest.getId(),
                    attemptId: attempt.getId(),
                    evaluationInstructions: dialogResult.instructions,
                    enableLlmMcqFeedback: dialogResult.enableLlmMcqFeedback === true,
                    // Paid decks route grading through the buyer's encrypted
                    // per-user entity store on the server.
                    paidDeckId: paidDeckId,
                    // Belt-and-braces: include the attempt JSON in the body
                    // so the Dock can proceed even when our pre-evaluation
                    // sync push hasn't fully landed yet in Mongo. The Dock
                    // prefers the stored copy when present and falls back
                    // to this snapshot when the attempt isn't there yet.
                    attemptSnapshot: attempt.toJson()
                })
            });

            if (evaluationResponse.status === 402)
            {
                const insufficientDetail = await evaluationResponse.json().catch(() => ({}));
                attempt.setEvaluationStatus(mockTestEvaluationStatuses.FAILED);
                try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }

                if (document.fullscreenElement)
                {
                    try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
                }

                await CreditNotice.showInsufficientCredits(insufficientDetail);
                PageNavigator.clearAndOpen("mock-test-answer-key-page", this.#mockTest, attempt);
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
                const previousAdditional = attempt.getAdditionalData() || {};
                attempt.setAdditionalData({ ...previousAdditional, evaluationTaskId: responseBody.taskId });
                try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }
            }
        }
        catch (requestError)
        {
            console.error("[MockTestSession] Failed to start evaluation task:", requestError);
            attempt.setEvaluationStatus(mockTestEvaluationStatuses.FAILED);
            try { await this.#mockTest.save(); } catch (resaveError) { /* ignore */ }

            if (document.fullscreenElement)
            {
                try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
            }

            await DialogBox.alert(
                "Evaluation failed to start",
                `The evaluation server returned an error: ${requestError?.message || "unknown"}. Your attempt is saved; you can re-evaluate it later from the answer key page.`
            );
            PageNavigator.clearAndOpen("mock-test-answer-key-page", this.#mockTest, attempt);
            return;
        }

        if (document.fullscreenElement)
        {
            try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
        }

        await DialogBox.alert(
            "Evaluation in progress",
            "Your attempt is being graded. Track progress in Activity — the score and examiner remarks will appear on the answer key page once it finishes."
        );
        PageNavigator.clearAndOpen("mock-test-answer-key-page", this.#mockTest, attempt);
    }

    static #attemptIsOfflineOnly(clonedItems)
    {
        const offlineGradableTypeKeys = new Set(MockTestEvaluationConstants.OFFLINE_GRADABLE_QUESTION_TYPES);
        for (const item of clonedItems)
        {
            if (!item || item.getType?.() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }
            const additionalData = item.getAdditionalData ? item.getAdditionalData() : {};
            const typeKey = MockTestSession.#resolveTypeKey(additionalData);
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

    static #resolveTypeKey(additionalData)
    {
        if (typeof additionalData.typeKey === "string" && additionalData.typeKey.length > 0)
        {
            return additionalData.typeKey;
        }
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

    static #computeMaxScore(items)
    {
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
                totalMarks += MockTestSession.resolveEffectiveQuestionMarks(null, item, currentSection);
            }
        }
        return totalMarks;
    }

    /**
     * Per-question effective marks. We prefer the marking scheme's resolved
     * correctMarks (honouring section / type overrides) — the question's static
     * `marks` field defaults to 1 when the LLM omits it, which makes per-question
     * badges and totals drift away from what the marking-scheme advertises. If
     * the question carries an explicit override (>1), that wins.
     *
     * `mockTest` may be null for the static PDF helpers — falls back to the
     * question's own marks in that case.
     */
    static resolveEffectiveQuestionMarks(mockTest, questionItem, sectionItem)
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

    // ── PDF Generation ────────────────────────────────────────────────────────

    async #buildPdf(progressCallback = null)
    {
        const doc = new window.jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4" });
        // When a progress callback is supplied, yield to the event loop between
        // items so the calling UI's loading indicator can repaint. Without
        // yielding, jsPDF would monopolise the main thread for the full build.
        const yieldIfProgressing = progressCallback
            ? () => new Promise((resolve) => setTimeout(resolve, 0))
            : null;

        const W  = 210;
        const H  = 297;
        const M  = 18;       // page margin
        const CW = W - 2*M;  // content width = 174mm

        let y       = M;
        let pageNum = 1;
        let qNum    = 0;

        // ── Helpers ────────────────────────────────────────────────────────────

        const newPage = () =>
        {
            drawFooter();
            doc.addPage();
            pageNum++;
            y = M;
        };

        // Ensure at least `need` mm remain before the bottom margin.
        const guard = (need) =>
        {
            if (y + need > H - M - 8) newPage();
        };

        const drawFooter = () =>
        {
            doc.setFont("helvetica", "normal");
            doc.setFontSize(8);
            doc.setTextColor(130, 130, 130);
            doc.text(
                sanitizeForJsPdf(`${this.#mockTest.getTitle() || "Mock Test"}  --  Page ${pageNum}`),
                W / 2, H - 8, { align: "center" }
            );
            doc.setTextColor(0, 0, 0);
        };

        const drawDottedLine = (xStart, xEnd, lineY) =>
        {
            doc.setLineDashPattern([0.5, 1.5], 0);
            doc.setLineWidth(0.2);
            doc.setDrawColor(180, 180, 180);
            doc.line(xStart, lineY, xEnd, lineY);
            doc.setLineDashPattern([], 0);
            doc.setDrawColor(0, 0, 0);
        };

        const writeText = (text, x, startY, maxW, fontSize, style, color = [0, 0, 0], align = "left") =>
        {
            doc.setFont("helvetica", style);
            doc.setFontSize(fontSize);
            doc.setTextColor(...color);
            const lines = doc.splitTextToSize(sanitizeForJsPdf(text), maxW);
            doc.text(lines, x, startY, { align });
            const lh = fontSize * 0.35278 * 1.35; // approx line height in mm
            return lines.length * lh;
        };

        // ── Compute total marks ────────────────────────────────────────────────

        const items = this.#mockTest.getItems();
        let totalMarks = 0;
        let totalMarksSection = null;

        for (const item of items)
        {
            if (item.getType() === mockTestItemTypes.SECTION)
            {
                totalMarksSection = item;
                continue;
            }
            if (item.getType() === mockTestItemTypes.QUESTION)
            {
                totalMarks += MockTestSession.resolveEffectiveQuestionMarks(this.#mockTest, item, totalMarksSection);
            }
        }

        // ── Header box ─────────────────────────────────────────────────────────
        // Outer double border
        doc.setLineWidth(0.8);
        doc.setDrawColor(0, 0, 0);
        doc.rect(M, y, CW, 30);
        doc.setLineWidth(0.25);
        doc.rect(M + 1.2, y + 1.2, CW - 2.4, 27.6);

        // Title
        doc.setFont("helvetica", "bold");
        doc.setFontSize(15);
        doc.setTextColor(0, 0, 0);
        const titleLines = doc.splitTextToSize(sanitizeForJsPdf(this.#mockTest.getTitle() || "Mock Test"), CW - 8);
        doc.text(titleLines, W / 2, y + 8, { align: "center" });

        // Thin divider
        const dividerY = y + 9 + titleLines.length * 5;
        doc.setLineWidth(0.3);
        doc.line(M + 2, dividerY, M + CW - 2, dividerY);

        // Duration (left) and Max Marks (right)
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        const duration = this.#mockTest.getDuration();
        doc.text(
            sanitizeForJsPdf(duration > 0 ? `Time Allowed: ${duration} minutes` : "Time Allowed: --"),
            M + 5, y + 26
        );
        doc.text(`Maximum Marks: ${totalMarks}`, M + CW - 5, y + 26, { align: "right" });

        y += 35;

        // ── Render items ───────────────────────────────────────────────────────

        let currentSection = null;
        let renderedItemCount = 0;
        const totalItemCount = items.length;

        for (const item of items)
        {
            const type = item.getType();

            // ── TITLE ──────────────────────────────────────────────────────────
            if (type === mockTestItemTypes.TITLE)
            {
                guard(12);
                y += 4;
                writeText(item.getTitle(), W / 2, y, CW, 13, "bold", [0, 0, 0], "center");
                y += 9;
            }

            // ── INSTRUCTIONS ──────────────────────────────────────────────────
            else if (type === mockTestItemTypes.INSTRUCTIONS)
            {
                guard(10);
                y += 3;

                // "General Instructions" label
                writeText("General Instructions:", M, y, CW, 9, "bolditalic");
                y += 5;

                const content       = item.getContent() || "";
                const lineHeight    = 9 * 0.35278 * 1.35;
                const textLines     = doc.splitTextToSize(sanitizeForJsPdf(content), CW);

                guard(textLines.length * lineHeight + 4);

                doc.setFont("helvetica", "italic");
                doc.setFontSize(9);
                doc.setTextColor(50, 50, 50);
                doc.text(textLines, M, y);
                doc.setTextColor(0, 0, 0);

                y += textLines.length * lineHeight + 5;

                // Separator rule
                doc.setLineWidth(0.4);
                doc.line(M, y, M + CW, y);
                y += 5;
            }

            // ── SECTION ───────────────────────────────────────────────────────
            else if (type === mockTestItemTypes.SECTION)
            {
                currentSection = item;

                guard(14);
                y += 4;

                // Shaded section banner
                doc.setFillColor(240, 240, 240);
                doc.rect(M, y - 1, CW, 8, "F");
                doc.setLineWidth(0.3);
                doc.rect(M, y - 1, CW, 8);

                doc.setFont("helvetica", "bold");
                doc.setFontSize(11);
                doc.setTextColor(0, 0, 0);
                doc.text(sanitizeForJsPdf(item.getTitle().toUpperCase()), M + 3, y + 4.5);

                // Description (if any)
                if (item.getDescription && item.getDescription())
                {
                    doc.setFont("helvetica", "italic");
                    doc.setFontSize(8.5);
                    doc.setTextColor(70, 70, 70);
                    doc.text(sanitizeForJsPdf(item.getDescription()), M + CW - 3, y + 4.5, { align: "right" });
                    doc.setTextColor(0, 0, 0);
                }

                y += 12;
            }

            // ── QUESTION ──────────────────────────────────────────────────────
            else if (type === mockTestItemTypes.QUESTION)
            {
                qNum++;
                const marks             = MockTestSession.resolveEffectiveQuestionMarks(this.#mockTest, item, currentSection);
                const additionalData    = item.getAdditionalData ? item.getAdditionalData() : {};
                const options           = additionalData.options;
                const questionType      = additionalData.type ?? null;
                const hasOptions        = Array.isArray(options) && options.length > 0;

                const questionLineHeight    = 10 * 0.35278 * 1.35;
                const questionPrefixWidth   = 10;  // mm reserved for "Q.n" label on the left
                const questionSuffixWidth   = 20;  // mm reserved for "[N M]" marks badge on the right
                const questionTextWidth     = CW - questionPrefixWidth - questionSuffixWidth;
                const questionX             = M + questionPrefixWidth;

                // Set font BEFORE splitTextToSize so jsPDF measures with the correct metrics
                doc.setFont("helvetica", "normal");
                doc.setFontSize(10);
                const questionLines = doc.splitTextToSize(sanitizeForJsPdf(item.getQuestion() || ""), questionTextWidth);
                let neededHeight    = questionLines.length * questionLineHeight + 4;

                if (hasOptions)
                {
                    // Pre-split options to get accurate height estimate
                    const optionLineHeightEstimate  = 8.5 * 0.35278 * 1.35;
                    const optionTextWidthEstimate   = (CW - questionPrefixWidth) / 2 - 12;
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(8.5);
                    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 2)
                    {
                        const leftOptionLines   = doc.splitTextToSize(sanitizeForJsPdf(options[optionIndex]), optionTextWidthEstimate);
                        const rightOptionLines  = optionIndex + 1 < options.length
                            ? doc.splitTextToSize(sanitizeForJsPdf(options[optionIndex + 1]), optionTextWidthEstimate)
                            : [];
                        neededHeight += Math.max(leftOptionLines.length, rightOptionLines.length) * optionLineHeightEstimate + 3;
                    }
                }
                else
                {
                    const blankLineCount = MockTestSession.#blankLinesByQuestionType.get(questionType) ?? 2;
                    neededHeight += blankLineCount * 6 + 2;
                }

                guard(neededHeight + 4);
                y += 2;

                // Question number label
                doc.setFont("helvetica", "bold");
                doc.setFontSize(10);
                doc.setTextColor(0, 0, 0);
                doc.text(`Q.${qNum}`, M, y + 3.5);

                // Question text — already split above with correct font
                doc.setFont("helvetica", "normal");
                doc.setFontSize(10);
                doc.text(questionLines, questionX, y + 3.5);

                // Marks badge pinned to the first line's baseline only
                doc.setFont("helvetica", "bolditalic");
                doc.setFontSize(9);
                doc.setTextColor(60, 60, 60);
                doc.text(`[${marks} M]`, M + CW, y + 3.5, { align: "right" });
                doc.setTextColor(0, 0, 0);

                y += questionLines.length * questionLineHeight + 3;

                // ── Options (MCQ / MULTIPLE_CORRECT) ──────────────────────────
                if (hasOptions)
                {
                    const optionLabels          = ["(a)", "(b)", "(c)", "(d)", "(e)", "(f)"];
                    const optionLineHeight      = 8.5 * 0.35278 * 1.35;
                    // Each column gets half the space from questionX onward, minus a centre gap
                    const columnWidth           = (CW - questionPrefixWidth) / 2 - 4;
                    const optionTextWidth       = columnWidth - 10; // minus label width
                    const leftColumnX           = questionX;
                    const rightColumnX          = questionX + columnWidth + 8;

                    // Process options in pairs so row height is max(left, right)
                    for (let optionIndex = 0; optionIndex < options.length; optionIndex += 2)
                    {
                        // Set font before splitting so metrics are correct
                        doc.setFont("helvetica", "normal");
                        doc.setFontSize(8.5);

                        const leftOptionLines   = doc.splitTextToSize(sanitizeForJsPdf(options[optionIndex]), optionTextWidth);
                        const rightOptionLines  = optionIndex + 1 < options.length
                            ? doc.splitTextToSize(sanitizeForJsPdf(options[optionIndex + 1]), optionTextWidth)
                            : [];

                        const rowHeight = Math.max(leftOptionLines.length, rightOptionLines.length) * optionLineHeight + 3;
                        guard(rowHeight);

                        // Left option
                        doc.setFont("helvetica", "bold");
                        doc.setFontSize(8.5);
                        doc.text(optionLabels[optionIndex] || `(${optionIndex + 1})`, leftColumnX, y + 3);
                        doc.setFont("helvetica", "normal");
                        doc.text(leftOptionLines, leftColumnX + 10, y + 3);

                        // Right option (if it exists)
                        if (optionIndex + 1 < options.length)
                        {
                            doc.setFont("helvetica", "bold");
                            doc.text(optionLabels[optionIndex + 1] || `(${optionIndex + 2})`, rightColumnX, y + 3);
                            doc.setFont("helvetica", "normal");
                            doc.text(rightOptionLines, rightColumnX + 10, y + 3);
                        }

                        y += rowHeight;
                    }

                    y += 2;
                }
                // ── Blank answer lines (subjective) ───────────────────────────
                else
                {
                    const blankLineCount = MockTestSession.#blankLinesByQuestionType.get(questionType) ?? 2;

                    for (let blankLineIndex = 0; blankLineIndex < blankLineCount; blankLineIndex++)
                    {
                        guard(6);
                        drawDottedLine(questionX, M + CW, y + 5);
                        y += 6;
                    }

                    y += 2;
                }

                y += 1;
            }

            renderedItemCount += 1;
            if (progressCallback)
            {
                progressCallback(renderedItemCount, totalItemCount);
            }
            if (yieldIfProgressing)
            {
                await yieldIfProgressing();
            }
        }

        // Final page footer
        drawFooter();

        return doc;
    }
}

export default MockTestSession;