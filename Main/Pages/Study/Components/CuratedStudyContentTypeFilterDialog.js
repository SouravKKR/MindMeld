import DialogBox from "../../../CommonComponents/DialogBox.js";


/**
 * CuratedStudyContentTypeFilterDialog
 *
 * Pre-Archive chooser that lets the user pick whether they want to see
 * the study materials, the flashcards, or both in the archive view.
 * The LIVE-batch session never offers this filter — that flow always
 * walks material then flashcards per topic, in the order the user
 * generated them. Archive viewing is read-only and looser, so the
 * filter applies only there.
 *
 * Returns a Promise resolving to one of:
 *   - "BOTH"        — default, both shown
 *   - "MATERIALS"   — only the simpler-language study materials shown
 *   - "FLASHCARDS"  — only the easy/hard flashcards shown
 *   - null          — user cancelled
 */
class CuratedStudyContentTypeFilterDialog
{
    static #STORAGE_KEY = "cogniumlearn-curated-archive-filter";

    static BOTH       = "BOTH";
    static MATERIALS  = "MATERIALS";
    static FLASHCARDS = "FLASHCARDS";

    static show()
    {
        return new Promise((resolve) =>
        {
            const initialSelection = CuratedStudyContentTypeFilterDialog.#readSavedSelection();

            const filterOptions = [
                { value: CuratedStudyContentTypeFilterDialog.BOTH,       label: "Both",                   description: "Show the study materials and the flashcards in the order they were generated." },
                { value: CuratedStudyContentTypeFilterDialog.MATERIALS,  label: "Study materials only",   description: "Show the simpler-language explanations only — no flashcards." },
                { value: CuratedStudyContentTypeFilterDialog.FLASHCARDS, label: "Flashcards only",        description: "Show the easy/hard flashcards only — no study materials." },
            ];

            const optionsHtml = filterOptions.map((filterOption) =>
            {
                const checkedAttribute = filterOption.value === initialSelection ? "checked" : "";
                return `
                    <div class="curated-content-filter-row">
                        <input type="radio" name="curated-content-filter" class="curated-content-filter-radio" id="curated-content-filter-${filterOption.value}" value="${filterOption.value}" ${checkedAttribute}>
                        <label for="curated-content-filter-${filterOption.value}">
                            <span class="curated-content-filter-label">${filterOption.label}</span>
                            <span class="curated-content-filter-description">${filterOption.description}</span>
                        </label>
                    </div>
                `;
            }).join("");

            const dialog = DialogBox.modal(`
                <h2 align="center">Show study materials, flashcards, or both?</h2>
                <div class="curated-content-filter-list">
                    ${optionsHtml}
                </div>
                <div class="curated-content-filter-actions">
                    <button class="curated-content-filter-cancel">Cancel</button>
                    <button class="curated-content-filter-confirm">Show archive</button>
                </div>
            `);

            const radioButtons = Array.from(dialog.querySelectorAll(".curated-content-filter-radio"));
            const confirmButton = dialog.querySelector(".curated-content-filter-confirm");
            const cancelButton  = dialog.querySelector(".curated-content-filter-cancel");

            let bResolved = false;
            const resolveOnce = (selectedValue) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                dialog.close();
                resolve(selectedValue);
            };

            confirmButton.addEventListener("click", () =>
            {
                const checkedRadio = radioButtons.find((radio) => radio.checked);
                const selectedValue = checkedRadio ? checkedRadio.value : CuratedStudyContentTypeFilterDialog.BOTH;
                CuratedStudyContentTypeFilterDialog.#persistSelection(selectedValue);
                resolveOnce(selectedValue);
            });

            cancelButton.addEventListener("click", () => resolveOnce(null));

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () => resolveOnce(null));
            }
        });
    }

    static #readSavedSelection()
    {
        try
        {
            const rawValue = window.localStorage.getItem(CuratedStudyContentTypeFilterDialog.#STORAGE_KEY);
            if (rawValue === CuratedStudyContentTypeFilterDialog.MATERIALS || rawValue === CuratedStudyContentTypeFilterDialog.FLASHCARDS)
            {
                return rawValue;
            }
            return CuratedStudyContentTypeFilterDialog.BOTH;
        }
        catch (storageError)
        {
            return CuratedStudyContentTypeFilterDialog.BOTH;
        }
    }

    static #persistSelection(selectedValue)
    {
        try
        {
            window.localStorage.setItem(CuratedStudyContentTypeFilterDialog.#STORAGE_KEY, selectedValue);
        }
        catch (storageError)
        {
            // localStorage may be unavailable; the picker still works
            // for the current session, just won't remember the choice.
        }
    }
}

export default CuratedStudyContentTypeFilterDialog;
