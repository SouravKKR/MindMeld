import DialogBox from "./DialogBox.js";
import { studyMaterialDetailLevels } from "../Globals/Enumerations/StudyMaterialDetailLevels.js";
import { enumerationToTitleCase } from "../Globals/UtilityFunctions/EnumerationToTitleCase.js";


/**
 * DetailLevelPickerDialog
 *
 * Pre-Content-Study chooser that lets the user pick which detail tiers
 * (Summary / Standard / Comprehensive) to play back in this session.
 * Returns a Promise that resolves with an array of selected enum values,
 * or null if the user cancels.
 *
 * Skipped by the caller (DeckTile.studyButton) when the deck has only one
 * available detail level — no point asking when there's no real choice.
 */
class DetailLevelPickerDialog
{
    static #LEVEL_DESCRIPTIONS =
    {
        SUMMARY: "Crisp bullets and key formulas for quick revision",
        STANDARD: "Balanced study notes",
        COMPREHENSIVE: "In-depth coverage with background and derivations"
    };

    /**
     * Opens the picker.
     * @param {number[]} availableLevels Detail-level enum values present in the deck.
     * @returns {Promise<number[]|null>} Selected levels, or null on cancel.
     */
    static show(availableLevels)
    {
        return new Promise((resolve) =>
        {
            const checkboxesHtml = availableLevels.map((levelValue) =>
            {
                const levelKey = DetailLevelPickerDialog.#getLevelKey(levelValue);
                const levelTitle = levelKey ? enumerationToTitleCase(levelKey) : `Level ${levelValue}`;
                const levelDescription = DetailLevelPickerDialog.#LEVEL_DESCRIPTIONS[levelKey] ?? "";
                const descriptionHtml = levelDescription ? ` <span class="detail-level-description">(${levelDescription})</span>` : "";

                return `
                    <div class="detail-level-picker-row">
                        <input type="checkbox" class="detail-level-picker-checkbox" id="detail-level-picker-${levelValue}" data-detail-level="${levelValue}" checked>
                        <label for="detail-level-picker-${levelValue}">${levelTitle}${descriptionHtml}</label>
                    </div>
                `;
            }).join("");

            const dialog = DialogBox.modal(`
                <h2 align="center">Which detail level do you want to study?</h2>
                <div class="detail-level-picker-list">
                    ${checkboxesHtml}
                </div>
                <div class="detail-level-picker-actions">
                    <button class="detail-level-picker-cancel">Cancel</button>
                    <button class="detail-level-picker-start">Start Study</button>
                </div>
            `);

            const checkboxes = Array.from(dialog.querySelectorAll(".detail-level-picker-checkbox"));
            const startButton = dialog.querySelector(".detail-level-picker-start");
            const cancelButton = dialog.querySelector(".detail-level-picker-cancel");

            const updateStartEnabled = () =>
            {
                startButton.disabled = !checkboxes.some(checkbox => checkbox.checked);
            };

            for (const checkbox of checkboxes)
            {
                checkbox.addEventListener("change", updateStartEnabled);
            }
            updateStartEnabled();

            let bResolved = false;

            startButton.addEventListener("click", () =>
            {
                if (bResolved) return;

                const selected = checkboxes
                    .filter(checkbox => checkbox.checked)
                    .map(checkbox => parseInt(checkbox.dataset.detailLevel, 10))
                    .filter(level => !Number.isNaN(level));

                bResolved = true;
                dialog.close();
                resolve(selected);
            });

            cancelButton.addEventListener("click", () =>
            {
                if (bResolved) return;
                bResolved = true;
                dialog.close();
                resolve(null);
            });

            // The close-button on DialogBox should also be treated as cancel.
            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () =>
                {
                    if (bResolved) return;
                    bResolved = true;
                    resolve(null);
                });
            }
        });
    }

    static #getLevelKey(levelValue)
    {
        for (const [key, value] of Object.entries(studyMaterialDetailLevels))
        {
            if (value === levelValue)
            {
                return key;
            }
        }
        return null;
    }
}

export default DetailLevelPickerDialog;
