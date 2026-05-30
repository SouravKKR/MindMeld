import DialogBox from "../../../CommonComponents/DialogBox.js";


/**
 * CuratedStudyCompletionDialog
 *
 * Two static methods cover the two terminal states of a curated
 * session:
 *
 *   - showAllEasy()          — congrats screen. Single OK button.
 *                              Returns Promise<void>.
 *   - showMixedResults(hardTopicGroups)
 *                            — two-choice prompt. Returns Promise<"continue"|"end">.
 *                              The hard topics list is shown so the
 *                              user knows what will be re-shown if
 *                              they pick Continue.
 *
 * Neither dialog touches state — the session decides what to do with
 * the result (archive, queue regen, navigate back).
 */
class CuratedStudyCompletionDialog
{
    static showAllEasy()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <h2 class="curated-completion-heading curated-completion-heading--success">All easy — well done!</h2>
                <p class="curated-completion-message">
                    You marked every flashcard in this curated batch as easy.
                    We are queueing a follow-up batch on the same topics so
                    you can keep tuning the same concepts when you are ready
                    — open Curated Study again later to pick it up.
                </p>
                <div class="curated-completion-actions">
                    <button class="curated-completion-ok">OK</button>
                </div>
            `);

            const finish = () =>
            {
                dialog.close();
                resolve();
            };

            dialog.querySelector(".curated-completion-ok").addEventListener("click", finish);
            const internalCloseButton = dialog.querySelector(".close-button");
            if (internalCloseButton)
            {
                internalCloseButton.addEventListener("click", finish);
            }
        });
    }

    static showMixedResults(hardTopicGroups)
    {
        return new Promise((resolve) =>
        {
            const topicListHtml = (hardTopicGroups || []).map((topicGroup) =>
            {
                const topicName = CuratedStudyCompletionDialog.#escapeHtml(topicGroup.topicName || "");
                const hardCount = (topicGroup.cards || []).filter((card) =>
                {
                    return card.getAdditionalData?.()?.lastCuratedGrade === "HARD";
                }).length;
                return `<li><strong>${topicName}</strong> — ${hardCount} hard flashcard${hardCount === 1 ? "" : "s"}</li>`;
            }).join("");

            const dialog = DialogBox.modal(`
                <h2 class="curated-completion-heading">Some flashcards were hard</h2>
                <p class="curated-completion-message">
                    You finished the batch but marked some flashcards as hard.
                    We can refine just those topics with a fresh study material
                    and a new set of flashcards informed by what you struggled
                    with — or you can end the session and come back later.
                </p>
                <div class="curated-completion-hard-topics">
                    <div class="curated-completion-hard-topics-heading">Topics to refine</div>
                    <ul class="curated-completion-hard-topics-list">${topicListHtml}</ul>
                </div>
                <div class="curated-completion-actions">
                    <button class="curated-completion-end">End session</button>
                    <button class="curated-completion-continue">Continue and refine</button>
                </div>
            `);

            const resolveWith = (choice) =>
            {
                dialog.close();
                resolve(choice);
            };

            dialog.querySelector(".curated-completion-continue").addEventListener("click", () => resolveWith("continue"));
            dialog.querySelector(".curated-completion-end").addEventListener("click", () => resolveWith("end"));
            const internalCloseButton = dialog.querySelector(".close-button");
            if (internalCloseButton)
            {
                // Treat the close-X like End session — it's the safer
                // default (no further LLM cost, no surprise regeneration).
                internalCloseButton.addEventListener("click", () => resolveWith("end"));
            }
        });
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

export default CuratedStudyCompletionDialog;
