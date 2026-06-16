import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import ContentStudySession from "../../Study/Classes/ContentStudySession.js";

class StudyMaterialOptionsContextMenu extends ContextMenu
{
    #material    = null;
    #browserPage = null;

    static tagName = "study-material-options-context-menu";

    initialize(position = { x: 0, y: 0 }, material, browserPage)
    {
        super.initialize(position);
        this.#material    = material;
        this.#browserPage = browserPage;
    }

    #handleEvents()
    {
        const editButton    = this.querySelector(".edit-button");
        const previewButton = this.querySelector(".preview-button");
        const deleteButton  = this.querySelector(".delete-button");

        editButton.addEventListener("click", () =>
        {
            PageNavigator.open("study-material-editor-page", this.#material, this.#material.getDeck());
        });

        previewButton.addEventListener("click", () =>
        {
            PageNavigator.open("study-page", ContentStudySession, this.#browserPage.getDeck(), null, { bPreview: true, startMaterial: this.#material });
        });

        deleteButton.addEventListener("click", async () =>
        {
            const confirmed = await DialogBox.confirm(
                "Delete Note",
                "Are you sure you want to delete this study material?<br><br>This action cannot be undone."
            );

            if(!confirmed) return;

            await this.#material.delete();
            this.#browserPage.refresh();
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="edit-button">Edit</button>
            <button class="preview-button">Preview</button>
            <button class="delete-button">Delete</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define("study-material-options-context-menu", StudyMaterialOptionsContextMenu);
export default StudyMaterialOptionsContextMenu;
