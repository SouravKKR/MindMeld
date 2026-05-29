import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { mockTestItemTypes } from "../../../Globals/Enumerations/MockTestItemTypes.js";
import MockTestSession from "../Classes/MockTestSession.js";

// Requires: Pages/Study/Styles/MockTestStartDialog.css

/**
 * Asks the user to pick an Online or Offline mode and a test duration,
 * then navigates into StudyPage with a MockTestSession set up for the
 * chosen options. Fullscreen is requested INSIDE the Start click
 * handler because browsers reject fullscreen requests that are not
 * directly tied to a user gesture.
 */
class MockTestStartDialog
{
    static MODE_ONLINE = "online";
    static MODE_OFFLINE = "offline";
    static MINIMUM_DURATION_MINUTES = 1;
    static FALLBACK_DURATION_MINUTES = 60;

    /**
     * @param {MockTest} mockTest
     * @param {HTMLElement|null} parentPickerDialog - The MockTestPickerModal dialog to close before navigating.
     * @param {boolean} bPreviewMode - When true, the resulting session is started in preview mode:
     *     the runner behaves identically but Finish does not persist an attempt. The dialog
     *     switches its labels ("Start Preview", "Exit Preview") so the user knows the run is
     *     throwaway.
     */
    static show(mockTest, parentPickerDialog = null, bPreviewMode = false)
    {
        if (!mockTest)
        {
            DialogBox.alert("No Mock Test", "Could not start: mock test is missing.");
            return;
        }

        const defaultDurationMinutes = MockTestStartDialog.#resolveDefaultDuration(mockTest);
        const totalMarks = MockTestStartDialog.#computeTotalMarks(mockTest);
        const markingSchemeText = MockTestStartDialog.#formatMarkingSchemeSummary(mockTest);

        const dialog = DialogBox.modal(MockTestStartDialog.#buildHtml(mockTest.getTitle() || "Mock Test", defaultDurationMinutes, totalMarks, markingSchemeText, bPreviewMode));

        dialog.style.padding = "0";
        dialog.style.overflow = "hidden";
        dialog.style.width = "min(520px, 94vw)";
        dialog.style.maxHeight = "min(90vh, 600px)";
        dialog.style.boxSizing = "border-box";

        const onlineRadio = dialog.querySelector(`input[name="mock-test-start-mode"][value="${MockTestStartDialog.MODE_ONLINE}"]`);
        const offlineRadio = dialog.querySelector(`input[name="mock-test-start-mode"][value="${MockTestStartDialog.MODE_OFFLINE}"]`);
        const durationInput = dialog.querySelector(".mock-test-start-duration-input");
        const startButton = dialog.querySelector(".mock-test-start-start-button");
        const cancelButton = dialog.querySelector(".mock-test-start-cancel-button");

        cancelButton.addEventListener("click", () =>
        {
            dialog.close();
        });

        startButton.addEventListener("click", async () =>
        {
            const selectedMode = onlineRadio.checked ? MockTestStartDialog.MODE_ONLINE : MockTestStartDialog.MODE_OFFLINE;
            const parsedMinutes = parseInt(durationInput.value, 10);
            const durationMinutes = Number.isFinite(parsedMinutes) && parsedMinutes >= MockTestStartDialog.MINIMUM_DURATION_MINUTES
                ? parsedMinutes
                : defaultDurationMinutes;

            // Fullscreen MUST be requested inside this click handler — the
            // user-activation token is consumed before navigation completes.
            // Failure is non-fatal; the runner will show a re-enter
            // affordance if fullscreenElement is null.
            try
            {
                await document.documentElement.requestFullscreen();
            }
            catch (fullscreenError)
            {
                // Browser denied (likely insecure context or user gesture lost);
                // continue without fullscreen.
            }

            if (parentPickerDialog && typeof parentPickerDialog.close === "function")
            {
                parentPickerDialog.close();
            }
            dialog.close();

            PageNavigator.open("study-page", MockTestSession, mockTest, { mode: selectedMode, durationMinutes: durationMinutes, bPreview: bPreviewMode });
        });
    }

    static #resolveDefaultDuration(mockTest)
    {
        const declaredDuration = mockTest.getDuration ? mockTest.getDuration() : 0;
        if (declaredDuration && declaredDuration > 0)
        {
            return declaredDuration;
        }
        return MockTestStartDialog.FALLBACK_DURATION_MINUTES;
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
                totalMarks += MockTestStartDialog.#resolveQuestionMarks(mockTest, item, currentSection);
            }
        }
        return totalMarks;
    }

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
            return "+1 correct / 0 wrong";
        }

        const correctMarks = Number(markingScheme.correctMarks) || 0;
        const wrongMarks = Number(markingScheme.wrongMarks) || 0;
        const partialMarks = Number(markingScheme.partialMarks) || 0;

        const parts = [];
        parts.push(`${correctMarks >= 0 ? "+" : ""}${correctMarks} correct`);
        parts.push(`${wrongMarks >= 0 ? "+" : ""}${wrongMarks} wrong`);
        if (partialMarks)
        {
            parts.push(`${partialMarks >= 0 ? "+" : ""}${partialMarks} partial`);
        }
        return parts.join(" / ");
    }

    static #buildHtml(testTitle, defaultDurationMinutes, totalMarks, markingSchemeText, bPreviewMode = false)
    {
        const headerLabel = bPreviewMode ? "Start Preview" : "Start Test";
        const startButtonLabel = bPreviewMode ? "Start Preview" : "Start Test";
        const previewNotice = bPreviewMode
            ? `<div class="mock-test-start-preview-notice">Preview mode — finishing the test will exit without saving any attempt.</div>`
            : "";
        return `
            <div class="mock-test-start-dialog-root">
                <div class="mock-test-start-dialog-header">
                    <div class="mock-test-start-dialog-title">${headerLabel}</div>
                    <div class="mock-test-start-dialog-subtitle">${testTitle}</div>
                </div>
                ${previewNotice}

                <div class="mock-test-start-dialog-body">

                    <div class="mock-test-start-info-row">
                        <span class="mock-test-start-info-pill">${totalMarks} marks total</span>
                        <span class="mock-test-start-info-pill">${markingSchemeText}</span>
                    </div>

                    <div class="mock-test-start-section">
                        <div class="mock-test-start-section-label">Mode</div>
                        <label class="mock-test-start-mode-option">
                            <input type="radio" name="mock-test-start-mode" value="${MockTestStartDialog.MODE_ONLINE}" checked />
                            <div class="mock-test-start-mode-option-body">
                                <div class="mock-test-start-mode-option-name">Online</div>
                                <div class="mock-test-start-mode-option-description">Type answers on screen. MCQs as radios, subjective answers in the rich editor.</div>
                            </div>
                        </label>
                        <label class="mock-test-start-mode-option">
                            <input type="radio" name="mock-test-start-mode" value="${MockTestStartDialog.MODE_OFFLINE}" />
                            <div class="mock-test-start-mode-option-body">
                                <div class="mock-test-start-mode-option-name">Offline</div>
                                <div class="mock-test-start-mode-option-description">Read on screen, write on paper. Upload scans when finished.</div>
                            </div>
                        </label>
                    </div>

                    <div class="mock-test-start-section">
                        <div class="mock-test-start-section-label">Duration (minutes)</div>
                        <input
                            type="number"
                            class="mock-test-start-duration-input"
                            min="${MockTestStartDialog.MINIMUM_DURATION_MINUTES}"
                            value="${defaultDurationMinutes}"
                        />
                        <div class="mock-test-start-duration-hint">Timer starts ticking immediately on Start. You can finish early.</div>
                    </div>

                </div>

                <div class="mock-test-start-dialog-footer">
                    <button class="mock-test-start-cancel-button" type="button">Cancel</button>
                    <button class="mock-test-start-start-button" type="button">${startButtonLabel}</button>
                </div>
            </div>
        `;
    }
}

export default MockTestStartDialog;
