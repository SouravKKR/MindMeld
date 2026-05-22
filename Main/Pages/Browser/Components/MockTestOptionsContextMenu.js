import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";

class MockTestOptionsContextMenu extends ContextMenu
{
    #mockTest    = null;
    #browserPage = null;

    static tagName = "mock-test-options-context-menu";

    initialize(position = { x: 0, y: 0 }, mockTest, browserPage)
    {
        super.initialize(position);
        this.#mockTest    = mockTest;
        this.#browserPage = browserPage;
    }

    #handleEvents()
    {
        const editButton   = this.querySelector(".edit-button");
        const deleteButton = this.querySelector(".delete-button");

        editButton.addEventListener("click", () =>
        {
            PageNavigator.open("mock-test-editor-page", this.#mockTest, this.#mockTest.getDeck());
        });

        deleteButton.addEventListener("click", async () =>
        {
            const confirmed = await DialogBox.confirm(
                "Delete Mock Test",
                "Are you sure you want to delete this mock test?<br><br>This action cannot be undone."
            );

            if(!confirmed) return;

            await this.#mockTest.delete();
            this.#browserPage.refresh();
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="edit-button">Edit</button>
            <button class="delete-button">Delete</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define("mock-test-options-context-menu", MockTestOptionsContextMenu);
export default MockTestOptionsContextMenu;
