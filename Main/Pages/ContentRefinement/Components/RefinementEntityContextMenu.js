import ContextMenu from "../../../CommonComponents/ContextMenu.js";

/**
 * RefinementEntityContextMenu — the right-click menu on a row of the refinement
 * entity list.
 *
 * It exists for one action the left mouse button cannot express. Once several
 * entities can be selected, clicking a row to LOOK at it is the same gesture as
 * clicking a row to select it, so inspecting the third item of a selection would
 * destroy the other nine. "Preview this" separates the two: it moves what is
 * rendered on the right and leaves the selection exactly as it was.
 *
 * The remaining entries are the selection operations that are awkward or
 * undiscoverable as modifier-clicks. "Select all visible" is scoped to the
 * current search term rather than the whole deck on purpose — a reviewer who has
 * filtered to "gas constant" means those, and a Select All that quietly reached
 * past the filter would submit and charge for passages they never saw.
 *
 * Carries the page rather than reaching for it, the same way
 * CardOptionsContextMenu does, so the menu has no opinion about how the page is
 * mounted and can be created from anywhere that already holds one.
 */
class RefinementEntityContextMenu extends ContextMenu
{
    static tagName = "refinement-entity-context-menu";

    #entityRow = null;
    #refinementPage = null;

    initialize(position, entityRow, refinementPage)
    {
        super.initialize(position);

        this.#entityRow = entityRow;
        this.#refinementPage = refinementPage;
    }

    connectedCallback()
    {
        const bAlreadySelected = this.#refinementPage.getSelection().contains(this.#entityRow);

        this.innerHTML =
        `
            <button class="preview-entity-button">Preview this</button>
            ${bAlreadySelected
                ? `<button class="remove-from-selection-button">Remove from selection</button>`
                : `<button class="add-to-selection-button">Add to selection</button>`}
            <button class="select-all-visible-button">Select all shown</button>
            <button class="clear-selection-button">Clear selection</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }

    #handleEvents()
    {
        const previewButton = this.querySelector(".preview-entity-button");
        const addButton = this.querySelector(".add-to-selection-button");
        const removeButton = this.querySelector(".remove-from-selection-button");
        const selectAllVisibleButton = this.querySelector(".select-all-visible-button");
        const clearSelectionButton = this.querySelector(".clear-selection-button");

        if (previewButton)
        {
            previewButton.addEventListener("click", () =>
            {
                this.remove();
                this.#refinementPage.setPreviewAnchor(Number(this.#entityRow.dataset.entityIndex));
            });
        }

        if (addButton)
        {
            addButton.addEventListener("click", () =>
            {
                this.remove();
                this.#refinementPage.getSelection().addSelection([this.#entityRow]);
                this.#refinementPage.refreshSelectionState();
            });
        }

        if (removeButton)
        {
            removeButton.addEventListener("click", () =>
            {
                this.remove();
                this.#refinementPage.getSelection().removeSelection([this.#entityRow]);
                this.#refinementPage.refreshSelectionState();
            });
        }

        if (selectAllVisibleButton)
        {
            selectAllVisibleButton.addEventListener("click", () =>
            {
                this.remove();
                this.#refinementPage.getSelection().addSelection(this.#refinementPage.getVisibleRows());
                this.#refinementPage.refreshSelectionState();
            });
        }

        if (clearSelectionButton)
        {
            clearSelectionButton.addEventListener("click", () =>
            {
                this.remove();
                this.#refinementPage.clearSelection();
            });
        }
    }
}

customElements.define(RefinementEntityContextMenu.tagName, RefinementEntityContextMenu);

export default RefinementEntityContextMenu;
