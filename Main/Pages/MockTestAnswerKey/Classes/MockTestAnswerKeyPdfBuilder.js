import { mockTestItemTypes } from "../../../Globals/Enumerations/MockTestItemTypes.js";
import { mockTestEvaluationStatuses } from "../../../Globals/Enumerations/MockTestEvaluationStatuses.js";
import sanitizeForJsPdf from "../../../Globals/UtilityFunctions/SanitizeForJsPdf.js";
import MockTestAnswerKeyPage from "../MockTestAnswerKeyPage.js";
import MockTestSession from "../../Study/Classes/MockTestSession.js";

/**
 * Builds a downloadable PDF of the answer key (expected answers, reasons
 * and solving steps) for a given MockTest. Layout mirrors the print PDF
 * built by MockTestSession, with the blank-line block replaced by the
 * answer-key rows.
 */
class MockTestAnswerKeyPdfBuilder
{
    static PAGE_MARGIN_MM = 18;
    static PAGE_WIDTH_MM = 210;
    static PAGE_HEIGHT_MM = 297;

    static buildPdfBlob(mockTest, attempt = null)
    {
        const pdfDocument = MockTestAnswerKeyPdfBuilder.#buildDocument(mockTest, attempt);
        return pdfDocument.output("blob");
    }

    static downloadPdf(mockTest, attempt = null)
    {
        const pdfDocument = MockTestAnswerKeyPdfBuilder.#buildDocument(mockTest, attempt);
        const title = mockTest.getTitle() || "Mock Test";
        const fileLabel = MockTestAnswerKeyPdfBuilder.#isCompleted(attempt) ? "Result" : "Answer Key";
        pdfDocument.save(`${title} — ${fileLabel}.pdf`);
    }

    static #isCompleted(attempt)
    {
        return !!(attempt && attempt.getEvaluationStatus && attempt.getEvaluationStatus() === mockTestEvaluationStatuses.COMPLETED);
    }

    static #buildGradedLookup(attempt)
    {
        const lookup = new Map();
        if (!MockTestAnswerKeyPdfBuilder.#isCompleted(attempt))
        {
            return lookup;
        }
        for (const item of attempt.getItems() || [])
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

    static #buildDocument(mockTest, attempt = null)
    {
        const gradedLookup = MockTestAnswerKeyPdfBuilder.#buildGradedLookup(attempt);
        const document = new window.jspdf.jsPDF({ orientation: "p", unit: "mm", format: "a4" });

        const pageMargin = MockTestAnswerKeyPdfBuilder.PAGE_MARGIN_MM;
        const pageWidth = MockTestAnswerKeyPdfBuilder.PAGE_WIDTH_MM;
        const pageHeight = MockTestAnswerKeyPdfBuilder.PAGE_HEIGHT_MM;
        const contentWidth = pageWidth - 2 * pageMargin;

        let cursorY = pageMargin;
        let pageNumber = 1;
        let runningQuestionNumber = 0;

        const drawFooter = () =>
        {
            document.setFont("helvetica", "normal");
            document.setFontSize(8);
            document.setTextColor(130, 130, 130);
            document.text(
                sanitizeForJsPdf(`${mockTest.getTitle() || "Mock Test"} — Answer Key — Page ${pageNumber}`),
                pageWidth / 2, pageHeight - 8, { align: "center" }
            );
            document.setTextColor(0, 0, 0);
        };

        const newPage = () =>
        {
            drawFooter();
            document.addPage();
            pageNumber += 1;
            cursorY = pageMargin;
        };

        const guardSpace = (requiredHeightMm) =>
        {
            if (cursorY + requiredHeightMm > pageHeight - pageMargin - 8)
            {
                newPage();
            }
            return cursorY;
        };

        const writeText = (text, originX, startY, maxWidth, fontSize, style, color = [0, 0, 0], align = "left") =>
        {
            document.setFont("helvetica", style);
            document.setFontSize(fontSize);
            document.setTextColor(...color);
            const wrappedLines = document.splitTextToSize(sanitizeForJsPdf(text), maxWidth);
            document.text(wrappedLines, originX, startY, { align });
            const lineHeightMm = fontSize * 0.35278 * 1.35;
            return wrappedLines.length * lineHeightMm;
        };

        // ── Header box ─────────────────────────────────────────────────────────
        document.setLineWidth(0.8);
        document.setDrawColor(0, 0, 0);
        document.rect(pageMargin, cursorY, contentWidth, 22);
        document.setLineWidth(0.25);
        document.rect(pageMargin + 1.2, cursorY + 1.2, contentWidth - 2.4, 19.6);

        document.setFont("helvetica", "bold");
        document.setFontSize(14);
        document.setTextColor(0, 0, 0);
        document.text(
            sanitizeForJsPdf(`${mockTest.getTitle() || "Mock Test"} — Answer Key`),
            pageWidth / 2, cursorY + 8, { align: "center" }
        );

        document.setFont("helvetica", "italic");
        document.setFontSize(9);
        document.setTextColor(80, 80, 80);
        document.text(
            sanitizeForJsPdf("Generated answer key. Distribute to students only after the exam."),
            pageWidth / 2, cursorY + 16, { align: "center" }
        );
        document.setTextColor(0, 0, 0);

        cursorY += 28;

        // ── Items ─────────────────────────────────────────────────────────────
        const items = mockTest.getItems() || [];
        let currentSection = null;

        for (const item of items)
        {
            const itemType = item.getType();

            if (itemType === mockTestItemTypes.TITLE)
            {
                guardSpace(12);
                cursorY += 4;
                cursorY += writeText(item.getTitle() || "", pageWidth / 2, cursorY, contentWidth, 13, "bold", [0, 0, 0], "center");
                cursorY += 4;
            }
            else if (itemType === mockTestItemTypes.INSTRUCTIONS)
            {
                guardSpace(10);
                cursorY += writeText("General Instructions:", pageMargin, cursorY, contentWidth, 9, "bolditalic");
                cursorY += 2;
                const instructionsContent = (item.getContent && item.getContent()) || "";
                if (instructionsContent)
                {
                    cursorY += writeText(instructionsContent, pageMargin, cursorY, contentWidth, 9, "italic", [50, 50, 50]);
                }
                cursorY += 4;
                document.setLineWidth(0.4);
                document.line(pageMargin, cursorY, pageMargin + contentWidth, cursorY);
                cursorY += 4;
            }
            else if (itemType === mockTestItemTypes.SECTION)
            {
                currentSection = item;
                guardSpace(14);
                cursorY += 2;
                document.setFillColor(240, 240, 240);
                document.rect(pageMargin, cursorY - 1, contentWidth, 8, "F");
                document.setLineWidth(0.3);
                document.rect(pageMargin, cursorY - 1, contentWidth, 8);
                document.setFont("helvetica", "bold");
                document.setFontSize(11);
                document.setTextColor(0, 0, 0);
                document.text(sanitizeForJsPdf((item.getTitle && item.getTitle()) || ""), pageMargin + 3, cursorY + 4.5);
                cursorY += 12;
            }
            else if (itemType === mockTestItemTypes.QUESTION)
            {
                runningQuestionNumber += 1;
                const gradedQuestion = gradedLookup.get(item.getId()) || null;
                cursorY = MockTestAnswerKeyPdfBuilder.#renderQuestion(document, item, runningQuestionNumber, pageMargin, contentWidth, cursorY, guardSpace, writeText, mockTest, currentSection, gradedQuestion);
            }
        }

        drawFooter();
        return document;
    }

    static #renderQuestion(document, questionItem, questionNumber, pageMargin, contentWidth, cursorY, guardSpace, writeText, mockTest = null, sectionItem = null, gradedQuestion = null)
    {
        const questionPrefixWidth = 12;
        const questionMarksWidth = 20;
        const questionTextWidth = contentWidth - questionPrefixWidth - questionMarksWidth;
        const questionX = pageMargin + questionPrefixWidth;
        const lineHeightMm = 10 * 0.35278 * 1.35;

        const additionalData = questionItem.getAdditionalData ? questionItem.getAdditionalData() : {};
        const options = Array.isArray(additionalData.options) ? additionalData.options : [];
        const marks = MockTestSession.resolveEffectiveQuestionMarks(mockTest, questionItem, sectionItem);
        const expectedAnswerRaw = questionItem.getExpectedAnswer ? questionItem.getExpectedAnswer() : "";
        const answerReason = questionItem.getAnswerReason ? questionItem.getAnswerReason() : "";
        const solvingSteps = questionItem.getSolvingSteps ? questionItem.getSolvingSteps() : "";

        document.setFont("helvetica", "normal");
        document.setFontSize(10);
        const questionLines = document.splitTextToSize(sanitizeForJsPdf(questionItem.getQuestion() || ""), questionTextWidth);
        cursorY = guardSpace(questionLines.length * lineHeightMm + 20);

        cursorY += 2;
        document.setFont("helvetica", "bold");
        document.setFontSize(10);
        document.text(`Q.${questionNumber}`, pageMargin, cursorY + 3.5);
        document.setFont("helvetica", "normal");
        document.text(questionLines, questionX, cursorY + 3.5);

        document.setFont("helvetica", "bolditalic");
        document.setFontSize(9);
        document.setTextColor(60, 60, 60);
        document.text(`[${marks} M]`, pageMargin + contentWidth, cursorY + 3.5, { align: "right" });
        document.setTextColor(0, 0, 0);

        cursorY += questionLines.length * lineHeightMm + 2;

        if (options.length > 0)
        {
            const optionLabels = MockTestAnswerKeyPage.OPTION_LETTERS_UPPERCASE;
            const optionLineHeight = 8.5 * 0.35278 * 1.35;

            for (let optionIndex = 0; optionIndex < options.length; optionIndex++)
            {
                const optionLabel = optionLabels[optionIndex] || `${optionIndex + 1}`;
                const isCorrect = MockTestAnswerKeyPdfBuilder.#isCorrectOption(expectedAnswerRaw, optionIndex);

                document.setFont("helvetica", "normal");
                document.setFontSize(8.5);
                const optionLines = document.splitTextToSize(sanitizeForJsPdf(options[optionIndex]), questionTextWidth - 14);
                const rowHeight = optionLines.length * optionLineHeight + 1;
                cursorY = guardSpace(rowHeight);

                document.setFont("helvetica", isCorrect ? "bold" : "normal");
                document.setTextColor(isCorrect ? 0 : 60, isCorrect ? 120 : 60, isCorrect ? 0 : 60);
                document.text(`${optionLabel}.`, questionX, cursorY + 3);
                document.text(optionLines, questionX + 7, cursorY + 3);
                document.setTextColor(0, 0, 0);
                cursorY += rowHeight;
            }
            cursorY += 1;
        }

        // Expected answer block
        const expectedAnswerDisplay = MockTestAnswerKeyPage.formatExpectedAnswer(expectedAnswerRaw, options);
        const labelX = questionX;
        const valueX = questionX + 32;
        const valueWidth = contentWidth - (valueX - pageMargin);

        cursorY += 2;
        document.setFont("helvetica", "bold");
        document.setFontSize(9);
        document.setTextColor(0, 90, 140);
        document.text("Expected Answer:", labelX, cursorY + 3);
        document.setTextColor(0, 0, 0);
        const expectedLines = document.splitTextToSize(sanitizeForJsPdf(expectedAnswerDisplay || "— not provided —"), valueWidth);
        document.setFont("helvetica", "normal");
        document.setFontSize(9);
        document.text(expectedLines, valueX, cursorY + 3);
        cursorY += Math.max(1, expectedLines.length) * (9 * 0.35278 * 1.35) + 1;

        if (answerReason)
        {
            cursorY = guardSpace(15);
            document.setFont("helvetica", "bold");
            document.setFontSize(9);
            document.setTextColor(0, 90, 140);
            document.text("Reason:", labelX, cursorY + 3);
            document.setTextColor(0, 0, 0);
            const reasonLines = document.splitTextToSize(sanitizeForJsPdf(answerReason), valueWidth);
            document.setFont("helvetica", "normal");
            document.setFontSize(9);
            document.text(reasonLines, valueX, cursorY + 3);
            cursorY += reasonLines.length * (9 * 0.35278 * 1.35) + 1;
        }

        if (solvingSteps)
        {
            cursorY = guardSpace(15);
            document.setFont("helvetica", "bold");
            document.setFontSize(9);
            document.setTextColor(0, 90, 140);
            document.text("Solving Steps:", labelX, cursorY + 3);
            document.setTextColor(0, 0, 0);
            const stepLines = document.splitTextToSize(sanitizeForJsPdf(solvingSteps), valueWidth);
            document.setFont("helvetica", "normal");
            document.setFontSize(9);
            document.text(stepLines, valueX, cursorY + 3);
            cursorY += stepLines.length * (9 * 0.35278 * 1.35) + 1;
        }

        if (gradedQuestion)
        {
            cursorY = MockTestAnswerKeyPdfBuilder.#renderGradedRows(document, gradedQuestion, marks, options, labelX, valueX, valueWidth, cursorY, guardSpace);
        }

        cursorY += 3;
        document.setLineDashPattern([0.5, 1.5], 0);
        document.setLineWidth(0.2);
        document.setDrawColor(180, 180, 180);
        document.line(pageMargin, cursorY, pageMargin + contentWidth, cursorY);
        document.setLineDashPattern([], 0);
        document.setDrawColor(0, 0, 0);
        cursorY += 3;

        return cursorY;
    }

    static #renderGradedRows(document, gradedQuestion, maxMarks, options, labelX, valueX, valueWidth, cursorY, guardSpace)
    {
        const userAnswerDisplay = MockTestAnswerKeyPdfBuilder.#formatUserAnswerForPdf(gradedQuestion.userAnswer, options);

        cursorY = guardSpace(15);
        document.setFont("helvetica", "bold");
        document.setFontSize(9);
        document.setTextColor(120, 60, 0);
        document.text("Your Answer:", labelX, cursorY + 3);
        document.setTextColor(0, 0, 0);
        const userLines = document.splitTextToSize(sanitizeForJsPdf(userAnswerDisplay || "— left blank —"), valueWidth);
        document.setFont("helvetica", "normal");
        document.setFontSize(9);
        document.text(userLines, valueX, cursorY + 3);
        cursorY += userLines.length * (9 * 0.35278 * 1.35) + 1;

        cursorY = guardSpace(12);
        document.setFont("helvetica", "bold");
        document.setFontSize(9);
        document.setTextColor(120, 60, 0);
        document.text("Score:", labelX, cursorY + 3);
        document.setTextColor(0, 0, 0);
        const scoreText = `${MockTestAnswerKeyPdfBuilder.#formatScore(gradedQuestion.score)} / ${maxMarks}`;
        const scoreLines = document.splitTextToSize(sanitizeForJsPdf(scoreText), valueWidth);
        document.setFont("helvetica", "normal");
        document.setFontSize(9);
        document.text(scoreLines, valueX, cursorY + 3);
        cursorY += scoreLines.length * (9 * 0.35278 * 1.35) + 1;

        if (gradedQuestion.remarks && String(gradedQuestion.remarks).trim().length > 0)
        {
            cursorY = guardSpace(15);
            document.setFont("helvetica", "bold");
            document.setFontSize(9);
            document.setTextColor(120, 60, 0);
            document.text("Examiner's Note:", labelX, cursorY + 3);
            document.setTextColor(0, 0, 0);
            const plainRemarks = String(gradedQuestion.remarks).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            const remarkLines = document.splitTextToSize(sanitizeForJsPdf(plainRemarks), valueWidth);
            document.setFont("helvetica", "italic");
            document.setFontSize(9);
            document.text(remarkLines, valueX, cursorY + 3);
            cursorY += remarkLines.length * (9 * 0.35278 * 1.35) + 1;
        }

        return cursorY;
    }

    static #formatUserAnswerForPdf(rawValue, options)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return "";
        }
        const text = String(rawValue);
        const hasOptions = Array.isArray(options) && options.length > 0;
        if (!hasOptions)
        {
            return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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
            // Fall through.
        }
        return text;
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

    static #isCorrectOption(rawExpectedAnswer, optionIndex)
    {
        if (rawExpectedAnswer === null || rawExpectedAnswer === undefined)
        {
            return false;
        }
        const tokens = String(rawExpectedAnswer).trim().split(/[,;|\s/]+/).filter((token) => token.length > 0);
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
}

export default MockTestAnswerKeyPdfBuilder;
