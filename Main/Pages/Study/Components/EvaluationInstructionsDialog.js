import DialogBox from "../../../CommonComponents/DialogBox.js";

/**
 * Reusable confirmation dialog for both the first-time submit flow and
 * the re-evaluate flow.
 *
 * Two optional inputs the candidate can supply per attempt:
 *   - **Evaluation instructions** — free-form text the LLM treats as soft
 *     guidance ("be lenient on minor unit slips", etc.). Suppressed when
 *     the attempt is offline-only (no LLM-graded questions).
 *   - **Get LLM feedback on MCQs** — opt-in checkbox. Off by default.
 *     When checked, MCQ + MULTIPLE_CORRECT questions are still scored
 *     deterministically by the offline grader, but additionally sent to
 *     the LLM so it can produce examiner remarks on the candidate's
 *     selections. Always visible — including in offline-only mode,
 *     because that's the only case where flipping this checkbox is the
 *     only path to surfacing any LLM commentary at all.
 *
 * Returns: { confirmed, instructions, enableLlmMcqFeedback }.
 */
class EvaluationInstructionsDialog
{
    static async open({ initialInstructions = "", initialEnableLlmMcqFeedback = false, isOfflineOnly = false, title = "Submit & Evaluate", confirmLabel = "Confirm" } = {})
    {
        const escapedInitial = EvaluationInstructionsDialog.#escapeHtml(initialInstructions || "");
        const checkedAttribute = initialEnableLlmMcqFeedback === true ? " checked" : "";

        const instructionsBlockHtml = isOfflineOnly
            ? `<p class="evaluation-instructions-dialog__hint">All scored questions in this attempt are objective (MCQ / multi-correct) — text instructions don't influence deterministic scoring. You can still opt in to LLM feedback below.</p>`
            : `
                <label class="evaluation-instructions-dialog__label" for="evaluation-instructions-input">
                    Evaluation instructions <span class="evaluation-instructions-dialog__optional">(optional)</span>
                </label>
                <textarea
                    id="evaluation-instructions-input"
                    class="evaluation-instructions-dialog__textarea"
                    rows="5"
                    placeholder="e.g. be lenient on minor unit slips, weight conceptual understanding over precise wording"
                >${escapedInitial}</textarea>
                <p class="evaluation-instructions-dialog__hint">Soft guidance for the grader — it cannot override the marking scheme or factual correctness, but it informs borderline judgement calls.</p>
            `;

        const mcqFeedbackBlockHtml = `
            <label class="evaluation-instructions-dialog__checkbox-row">
                <input
                    type="checkbox"
                    class="evaluation-instructions-dialog__mcq-feedback-checkbox"
                    ${checkedAttribute}
                />
                <span class="evaluation-instructions-dialog__checkbox-label">
                    Get LLM feedback on MCQs
                </span>
            </label>
            <p class="evaluation-instructions-dialog__hint">Sends MCQ + multi-correct questions to the LLM so it can comment on your selection. Costs additional credits. The score itself is still graded deterministically — only the examiner remarks come from the LLM.</p>
        `;

        const html = `
            <div class="evaluation-instructions-dialog">
                <div class="evaluation-instructions-dialog__title">${EvaluationInstructionsDialog.#escapeHtml(title)}</div>
                <div class="evaluation-instructions-dialog__body">
                    ${instructionsBlockHtml}
                    <div class="evaluation-instructions-dialog__divider"></div>
                    ${mcqFeedbackBlockHtml}
                </div>
                <div class="evaluation-instructions-dialog__buttons">
                    <button class="evaluation-instructions-dialog__confirm">${EvaluationInstructionsDialog.#escapeHtml(confirmLabel)}</button>
                    <button class="evaluation-instructions-dialog__cancel">Cancel</button>
                </div>
            </div>
        `;

        const dialog = DialogBox.modal(html);

        return await new Promise((resolve) =>
        {
            const confirmButton = dialog.querySelector(".evaluation-instructions-dialog__confirm");
            const cancelButton = dialog.querySelector(".evaluation-instructions-dialog__cancel");
            const textareaElement = dialog.querySelector(".evaluation-instructions-dialog__textarea");
            const mcqFeedbackCheckbox = dialog.querySelector(".evaluation-instructions-dialog__mcq-feedback-checkbox");

            confirmButton.addEventListener("click", () =>
            {
                const instructionsValue = textareaElement ? textareaElement.value : "";
                const enableLlmMcqFeedback = mcqFeedbackCheckbox ? mcqFeedbackCheckbox.checked === true : false;
                dialog.close();
                resolve({ confirmed: true, instructions: instructionsValue, enableLlmMcqFeedback: enableLlmMcqFeedback });
            });

            cancelButton.addEventListener("click", () =>
            {
                dialog.close();
                resolve({ confirmed: false, instructions: initialInstructions, enableLlmMcqFeedback: initialEnableLlmMcqFeedback === true });
            });
        });
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
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

export default EvaluationInstructionsDialog;
