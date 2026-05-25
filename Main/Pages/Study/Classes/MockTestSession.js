import { mockTestItemTypes } from "../../../Globals/Enumerations/MockTestItemTypes.js";
import { questionTypes } from "../../../Globals/Enumerations/QuestionTypes.js";
import sanitizeForJsPdf from "../../../Globals/UtilityFunctions/SanitizeForJsPdf.js";
import StudySession from "./StudySession.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import MockTestAttempt from "../../../Globals/Model/MockTestEntities/MockTestAttempt.js";
import MockTestItemFactory from "../../../Globals/Model/MockTestEntities/MockTestItemFactory.js";
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
     * Builds a jsPDF document for the given mock test and returns it as a Blob.
     * Can be called without a StudyPage instance — used by MockTestPickerModal.
     * @param {MockTest} mockTest
     * @returns {Blob}
     */
    static buildPdfBlob(mockTest)
    {
        const temporarySession = new MockTestSession(null, mockTest);
        const pdfDocument = temporarySession.#buildPdf();
        return pdfDocument.output("blob");
    }

    /**
     * Builds a jsPDF document for the given mock test and triggers a download.
     * Can be called without a StudyPage instance — used by MockTestPickerModal.
     * @param {MockTest} mockTest
     */
    static downloadPdf(mockTest)
    {
        const temporarySession = new MockTestSession(null, mockTest);
        const pdfDocument = temporarySession.#buildPdf();
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

        this.#mockTest.addAttempt(attempt);

        try
        {
            await this.#mockTest.save();
        }
        catch (saveError)
        {
            console.error("[MockTestSession] Failed to persist attempt:", saveError);
        }

        if (document.fullscreenElement)
        {
            try { await document.exitFullscreen(); } catch (exitError) { /* ignore */ }
        }

        await DialogBox.alert("Submitted", "Your attempt has been recorded. Evaluation will be wired later.");
        PageNavigator.back();
    }

    static #computeMaxScore(items)
    {
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

    // ── PDF Generation ────────────────────────────────────────────────────────

    #buildPdf()
    {
        const doc = new window.jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4" });

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

        for (const item of items)
        {
            if (item.getType() === mockTestItemTypes.QUESTION)
            {
                totalMarks += item.getMarks ? item.getMarks() : 0;
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
                const marks             = item.getMarks ? item.getMarks() : 1;
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
                    for (let i = 0; i < options.length; i += 2)
                    {
                        const leftOptionLines   = doc.splitTextToSize(sanitizeForJsPdf(options[i]), optionTextWidthEstimate);
                        const rightOptionLines  = i + 1 < options.length
                            ? doc.splitTextToSize(sanitizeForJsPdf(options[i + 1]), optionTextWidthEstimate)
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
                    for (let i = 0; i < options.length; i += 2)
                    {
                        // Set font before splitting so metrics are correct
                        doc.setFont("helvetica", "normal");
                        doc.setFontSize(8.5);

                        const leftOptionLines   = doc.splitTextToSize(sanitizeForJsPdf(options[i]), optionTextWidth);
                        const rightOptionLines  = i + 1 < options.length
                            ? doc.splitTextToSize(sanitizeForJsPdf(options[i + 1]), optionTextWidth)
                            : [];

                        const rowHeight = Math.max(leftOptionLines.length, rightOptionLines.length) * optionLineHeight + 3;
                        guard(rowHeight);

                        // Left option
                        doc.setFont("helvetica", "bold");
                        doc.setFontSize(8.5);
                        doc.text(optionLabels[i] || `(${i + 1})`, leftColumnX, y + 3);
                        doc.setFont("helvetica", "normal");
                        doc.text(leftOptionLines, leftColumnX + 10, y + 3);

                        // Right option (if it exists)
                        if (i + 1 < options.length)
                        {
                            doc.setFont("helvetica", "bold");
                            doc.text(optionLabels[i + 1] || `(${i + 2})`, rightColumnX, y + 3);
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

                    for (let i = 0; i < blankLineCount; i++)
                    {
                        guard(6);
                        drawDottedLine(questionX, M + CW, y + 5);
                        y += 6;
                    }

                    y += 2;
                }

                y += 1;
            }
        }

        // Final page footer
        drawFooter();

        return doc;
    }
}

export default MockTestSession;