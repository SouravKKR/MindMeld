import CuratedFlashcardFields from "../../../Globals/Classes/Analysis/CuratedFlashcardFields.js";
import CuratedStudyController from "../../../Globals/Classes/CuratedStudy/CuratedStudyController.js";
import CuratedStudyContentTypeFilterDialog from "./CuratedStudyContentTypeFilterDialog.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";


/**
 * CuratedStudyArchiveDialog
 *
 * Read-only browser for past curated batches. Each batch is rendered as
 * an expandable card showing the generation date, the session outcome
 * label, and the topic count. Expanding the card reveals each topic in
 * topicIndex order, with its material (preview + click-to-open) and
 * its flashcards (collapsed, click-to-reveal-answer).
 *
 * The content-type filter ("Materials only" / "Flashcards only" /
 * "Both", picked up-front via CuratedStudyContentTypeFilterDialog)
 * hides whichever section the user did not ask for; the underlying
 * data is identical either way.
 *
 * No grading or read-marking happens here — the archive is purely a
 * historical view. The Easy/Hard buttons live exclusively on the LIVE
 * session.
 */
class CuratedStudyArchiveDialog
{
    static async show(deck, contentFilter)
    {
        const archivedBatches = CuratedStudyController.getArchivedBatches(deck);

        const showMaterials  = contentFilter !== CuratedStudyContentTypeFilterDialog.FLASHCARDS;
        const showFlashcards = contentFilter !== CuratedStudyContentTypeFilterDialog.MATERIALS;

        if (archivedBatches.length === 0)
        {
            DialogBox.alert("Archive", "No archived curated batches yet. Once you complete or replace a curated batch, it will land here.");
            return;
        }

        const batchesHtml = archivedBatches.map((archivedBatch, batchIndex) =>
        {
            const dateLabel    = CuratedStudyArchiveDialog.#formatBatchDate(archivedBatch.generatedAt);
            const outcomeLabel = CuratedStudyArchiveDialog.#formatOutcome(archivedBatch.outcome, archivedBatch.batchReviewState);
            const topicCount   = archivedBatch.topicGroups.length;

            const topicsHtml = archivedBatch.topicGroups.map((topicGroup, topicGroupIndex) =>
            {
                const materialHtml = showMaterials && topicGroup.material
                    ? `
                        <div class="curated-archive-material">
                            <div class="curated-archive-material-heading">Study material</div>
                            <button class="curated-archive-material-open" data-batch-index="${batchIndex}" data-topic-index="${topicGroupIndex}">
                                Open full material
                            </button>
                        </div>
                    `
                    : "";

                const flashcardsHtml = showFlashcards && topicGroup.cards.length > 0
                    ? `
                        <div class="curated-archive-flashcards">
                            <div class="curated-archive-flashcards-heading">Flashcards (${topicGroup.cards.length})</div>
                            <ol class="curated-archive-flashcards-list">
                                ${topicGroup.cards.map((card, cardIndex) =>
                                {
                                    const lastGrade = card.getAdditionalData()?.[CuratedFlashcardFields.LAST_CURATED_GRADE] || "UNGRADED";
                                    return `
                                        <li class="curated-archive-flashcard">
                                            <button class="curated-archive-flashcard-question" data-batch-index="${batchIndex}" data-topic-index="${topicGroupIndex}" data-card-index="${cardIndex}">
                                                <span class="curated-archive-flashcard-grade-pill curated-archive-flashcard-grade-pill--${CuratedStudyArchiveDialog.#escapeHtml(lastGrade.toLowerCase())}">${CuratedStudyArchiveDialog.#escapeHtml(lastGrade)}</span>
                                                <span class="curated-archive-flashcard-question-text">${CuratedStudyArchiveDialog.#escapeHtml(card.getQuestion?.() || "")}</span>
                                            </button>
                                            <div class="curated-archive-flashcard-answer" hidden>${card.getAnswer?.() || ""}</div>
                                        </li>
                                    `;
                                }).join("")}
                            </ol>
                        </div>
                    `
                    : "";

                return `
                    <div class="curated-archive-topic">
                        <div class="curated-archive-topic-header">
                            <span class="curated-archive-topic-name">${CuratedStudyArchiveDialog.#escapeHtml(topicGroup.topicName)}</span>
                            <span class="curated-archive-topic-strength">${CuratedStudyArchiveDialog.#escapeHtml(topicGroup.topicStrength)}</span>
                        </div>
                        ${materialHtml}
                        ${flashcardsHtml}
                    </div>
                `;
            }).join("");

            return `
                <details class="curated-archive-batch" data-batch-index="${batchIndex}">
                    <summary class="curated-archive-batch-summary">
                        <span class="curated-archive-batch-date">${CuratedStudyArchiveDialog.#escapeHtml(dateLabel)}</span>
                        <span class="curated-archive-batch-outcome curated-archive-batch-outcome--${CuratedStudyArchiveDialog.#escapeHtml(String(archivedBatch.outcome || "unknown").toLowerCase())}">${CuratedStudyArchiveDialog.#escapeHtml(outcomeLabel)}</span>
                        <span class="curated-archive-batch-topic-count">${topicCount} topic${topicCount === 1 ? "" : "s"}</span>
                    </summary>
                    <div class="curated-archive-batch-body">
                        ${topicsHtml}
                    </div>
                </details>
            `;
        }).join("");

        const dialog = DialogBox.modal(`
            <h2 align="center">Curated study archive</h2>
            <p align="center" class="curated-archive-deck-name">${CuratedStudyArchiveDialog.#escapeHtml(deck.getName?.() || "")}</p>
            <div class="curated-archive-list">
                ${batchesHtml}
            </div>
            <div class="curated-archive-actions">
                <button class="curated-archive-close">Close</button>
            </div>
        `);

        // Wire flashcard show/hide.
        const flashcardButtons = Array.from(dialog.querySelectorAll(".curated-archive-flashcard-question"));
        for (const flashcardButton of flashcardButtons)
        {
            flashcardButton.addEventListener("click", () =>
            {
                const answerElement = flashcardButton.nextElementSibling;
                if (answerElement)
                {
                    answerElement.hidden = !answerElement.hidden;
                }
            });
        }

        // Wire material "open full" buttons. Pops a second DialogBox
        // with the material's HTML — read-only, no editing.
        const materialOpenButtons = Array.from(dialog.querySelectorAll(".curated-archive-material-open"));
        for (const materialOpenButton of materialOpenButtons)
        {
            materialOpenButton.addEventListener("click", () =>
            {
                const batchIndex = parseInt(materialOpenButton.dataset.batchIndex, 10);
                const topicIndex = parseInt(materialOpenButton.dataset.topicIndex, 10);
                if (Number.isNaN(batchIndex) || Number.isNaN(topicIndex))
                {
                    return;
                }
                const archivedBatch = archivedBatches[batchIndex];
                const topicGroup    = archivedBatch?.topicGroups[topicIndex];
                if (!topicGroup || !topicGroup.material)
                {
                    return;
                }
                CuratedStudyArchiveDialog.#showMaterialViewer(topicGroup);
            });
        }

        const closeButton = dialog.querySelector(".curated-archive-close");
        closeButton.addEventListener("click", () => dialog.close());
        const internalCloseButton = dialog.querySelector(".close-button");
        if (internalCloseButton)
        {
            internalCloseButton.addEventListener("click", () => dialog.close());
        }
    }

    static #showMaterialViewer(topicGroup)
    {
        const materialContent = topicGroup.material.getContent?.() || "";
        const viewerDialog = DialogBox.modal(`
            <h2 class="curated-archive-material-viewer-title">${CuratedStudyArchiveDialog.#escapeHtml(topicGroup.topicName)}</h2>
            <div class="curated-archive-material-viewer-content">${materialContent}</div>
            <div class="curated-archive-material-viewer-actions">
                <button class="curated-archive-material-viewer-close">Close</button>
            </div>
        `);
        const closeButton = viewerDialog.querySelector(".curated-archive-material-viewer-close");
        closeButton.addEventListener("click", () => viewerDialog.close());
        const internalCloseButton = viewerDialog.querySelector(".close-button");
        if (internalCloseButton)
        {
            internalCloseButton.addEventListener("click", () => viewerDialog.close());
        }
    }

    static #formatBatchDate(batchTag)
    {
        const parsed = Date.parse(batchTag);
        if (!Number.isFinite(parsed))
        {
            return "Unknown date";
        }
        return new Date(parsed).toLocaleString();
    }

    static #formatOutcome(outcomeName, batchReviewState)
    {
        switch (outcomeName)
        {
            case "COMPLETED_ALL_EASY":  return "Completed — all easy";
            case "ENDED_WITH_HARDS":    return "Ended with hards";
            case "REPLACED_BY_REGEN":   return "Replaced by regenerate";
            case "AUTO_REPLACED":       return "Auto-replaced";
            case "IN_PROGRESS":         return batchReviewState === "SUPERSEDED" ? "Auto-replaced" : "In progress";
            default:                    return batchReviewState === "SUPERSEDED" ? "Auto-replaced" : "Archived";
        }
    }

    static #escapeHtml(value)
    {
        if (typeof value !== "string")
        {
            return "";
        }
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default CuratedStudyArchiveDialog;
