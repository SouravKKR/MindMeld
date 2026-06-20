import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import Card from "../../../Globals/Model/Card.js";
import StudyMaterial from "../../../Globals/Model/StudyMaterial.js";

/**
 * StudyContextMenu
 *
 * The general-purpose right-click context menu for a Study session,
 * shown when the user right-clicks without an active text selection.
 * When a selection IS active, TextSelectionContextMenu handles it via
 * the selection watcher — that flow is intentionally left alone, so
 * this menu only covers the "empty right-click" gap.
 *
 * The menu currently offers a single action — Edit — which routes to
 * the appropriate editor for whichever entity is currently being
 * studied (Card -> card-editor-page, StudyMaterial ->
 * study-material-editor-page). More entries can be added later by
 * extending the inner template and the #handleEvents wiring.
 *
 * Mock-test sessions are skipped at the StudyPage level (the runner
 * owns its own UX), so this menu never appears there.
 */
class StudyContextMenu extends ContextMenu
{
    static tagName = "study-context-menu";

    #activeEntity = null;

    initialize(position = { x: 0, y: 0 }, activeEntity = null)
    {
        super.initialize(position);
        this.#activeEntity = activeEntity;
    }

    #handleEvents()
    {
        const editButton = this.querySelector(".study-context-edit-button");

        editButton?.addEventListener("click", () =>
        {
            if (this.#activeEntity instanceof Card)
            {
                PageNavigator.open("card-editor-page", this.#activeEntity, this.#activeEntity.getDeck());
                return;
            }

            if (this.#activeEntity instanceof StudyMaterial)
            {
                PageNavigator.open("study-material-editor-page", this.#activeEntity, this.#activeEntity.getDeck());
                return;
            }
        });
    }

    connectedCallback()
    {
        // Disable Edit if we couldn't determine an entity — the menu
        // still shows (so future entries remain reachable) but Edit
        // refuses to route into the wrong editor.
        const bDisableEdit = !(this.#activeEntity instanceof Card)
            && !(this.#activeEntity instanceof StudyMaterial);

        this.innerHTML =
        `
            <button
                class="study-context-edit-button"
                type="button"
                ${bDisableEdit ? "disabled" : ""}
            >Edit</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define(StudyContextMenu.tagName, StudyContextMenu);
export default StudyContextMenu;
