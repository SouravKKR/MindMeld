import DialogBox from "./DialogBox.js";


/**
 * Modal that surfaces a previous batch of curated study materials and
 * lets the user decide what to do with each: archive (keep around with
 * a "Previously curated" badge), keep (treat as a regular study
 * material), or delete (remove entirely). Bulk-action buttons cover
 * the common "do the same thing to everything" cases.
 *
 * The dialog never persists anything itself — it resolves a Map keyed
 * by study-material id, value `"archive" | "keep" | "delete"`, which
 * the caller applies via the StudyMaterial / Deck APIs.
 */
class CuratedStudyMaterialBatchReviewDialog
{
    static #ACTION_ARCHIVE = "archive";
    static #ACTION_KEEP    = "keep";
    static #ACTION_DELETE  = "delete";

    /**
     * Presents the dialog for the given previous-batch study materials.
     * Returns a Promise that resolves to a Map<materialId, actionString>.
     * If the user closes the dialog without confirming, the Map is empty.
     *
     * @param {Array<{id: string, title: string, topicName: string, preview: string}>} previousBatchEntries
     * @returns {Promise<Map<string, string>>}
     */
    static present(previousBatchEntries)
    {
        if (!Array.isArray(previousBatchEntries) || previousBatchEntries.length === 0)
        {
            return Promise.resolve(new Map());
        }

        return new Promise((resolve) =>
        {
            const entriesHtml = previousBatchEntries.map((entry, entryIndex) =>
            {
                const safeTitle = entry.title || entry.topicName || `Curated material ${entryIndex + 1}`;
                const safePreview = (entry.preview || "").substring(0, 220);

                return `
                    <div class="curated-batch-review-entry" data-material-id="${entry.id}">
                        <div class="curated-batch-review-entry-header">
                            <span class="curated-batch-review-entry-title">${safeTitle}</span>
                        </div>
                        ${safePreview ? `<div class="curated-batch-review-entry-preview">${safePreview}…</div>` : ""}
                        <div class="curated-batch-review-entry-actions">
                            <label class="curated-batch-review-radio">
                                <input type="radio" name="action-${entry.id}" value="${CuratedStudyMaterialBatchReviewDialog.#ACTION_ARCHIVE}" checked>
                                <span>Archive</span>
                            </label>
                            <label class="curated-batch-review-radio">
                                <input type="radio" name="action-${entry.id}" value="${CuratedStudyMaterialBatchReviewDialog.#ACTION_KEEP}">
                                <span>Keep</span>
                            </label>
                            <label class="curated-batch-review-radio">
                                <input type="radio" name="action-${entry.id}" value="${CuratedStudyMaterialBatchReviewDialog.#ACTION_DELETE}">
                                <span>Delete</span>
                            </label>
                        </div>
                    </div>
                `;
            }).join("");

            const modalHtml = `
                <div class="curated-batch-review-dialog">
                    <h2 class="curated-batch-review-title">Review previous curated study materials</h2>
                    <p class="curated-batch-review-body">
                        A new batch of curated materials has been generated for your weak topics.
                        Choose what to do with each material from the previous batch.
                    </p>
                    <div class="curated-batch-review-bulk-row">
                        <button class="curated-batch-review-bulk-button" data-bulk-action="${CuratedStudyMaterialBatchReviewDialog.#ACTION_ARCHIVE}">Archive all</button>
                        <button class="curated-batch-review-bulk-button" data-bulk-action="${CuratedStudyMaterialBatchReviewDialog.#ACTION_KEEP}">Keep all</button>
                        <button class="curated-batch-review-bulk-button" data-bulk-action="${CuratedStudyMaterialBatchReviewDialog.#ACTION_DELETE}">Delete all</button>
                    </div>
                    <div class="curated-batch-review-entries">${entriesHtml}</div>
                    <div class="curated-batch-review-confirm-row">
                        <button class="curated-batch-review-confirm-button">Apply choices</button>
                    </div>
                </div>
            `;

            const dialog = DialogBox.modal(modalHtml);

            const applyBulkAction = (bulkActionValue) =>
            {
                const radioButtons = dialog.querySelectorAll(`.curated-batch-review-entry input[type="radio"][value="${bulkActionValue}"]`);
                for (const radioButton of radioButtons)
                {
                    radioButton.checked = true;
                }
            };

            const bulkButtons = dialog.querySelectorAll(".curated-batch-review-bulk-button");
            for (const bulkButton of bulkButtons)
            {
                bulkButton.addEventListener("click", () =>
                {
                    applyBulkAction(bulkButton.getAttribute("data-bulk-action"));
                });
            }

            const confirmButton = dialog.querySelector(".curated-batch-review-confirm-button");
            confirmButton.addEventListener("click", () =>
            {
                const decisionMap = new Map();
                const entryElements = dialog.querySelectorAll(".curated-batch-review-entry");

                for (const entryElement of entryElements)
                {
                    const materialId = entryElement.getAttribute("data-material-id");
                    const selectedRadio = entryElement.querySelector("input[type=\"radio\"]:checked");
                    const selectedAction = selectedRadio ? selectedRadio.value : CuratedStudyMaterialBatchReviewDialog.#ACTION_ARCHIVE;

                    decisionMap.set(materialId, selectedAction);
                }

                dialog.close();
                resolve(decisionMap);
            });
        });
    }

    static getArchiveAction()
    {
        return CuratedStudyMaterialBatchReviewDialog.#ACTION_ARCHIVE;
    }

    static getKeepAction()
    {
        return CuratedStudyMaterialBatchReviewDialog.#ACTION_KEEP;
    }

    static getDeleteAction()
    {
        return CuratedStudyMaterialBatchReviewDialog.#ACTION_DELETE;
    }
}

export default CuratedStudyMaterialBatchReviewDialog;
