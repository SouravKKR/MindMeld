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
        const editButton           = this.querySelector(".edit-button");
        const clearAttemptsButton  = this.querySelector(".clear-attempts-button");
        const deleteButton         = this.querySelector(".delete-button");

        editButton.addEventListener("click", () =>
        {
            PageNavigator.open("mock-test-editor-page", this.#mockTest, this.#mockTest.getDeck());
        });

        clearAttemptsButton.addEventListener("click", async () =>
        {
            const attemptCount = this.#mockTest.getHistory ? this.#mockTest.getHistory().length : 0;
            if (attemptCount === 0)
            {
                await DialogBox.alert("Clear Attempts", "This mock test has no attempts to clear.");
                return;
            }

            const confirmed = await DialogBox.confirm(
                "Clear Attempts",
                `Are you sure you want to delete all ${attemptCount} attempt${attemptCount === 1 ? "" : "s"} for this mock test?<br><br>This action cannot be undone.`
            );

            if(!confirmed) return;

            this.#mockTest.clearAttempts();
            try
            {
                await this.#mockTest.save();
            }
            catch (saveError)
            {
                console.error("[MockTestOptionsContextMenu] Failed to save mock test after clearing attempts:", saveError);
                await DialogBox.alert("Clear Attempts", "The attempts were removed locally but couldn't be saved. Try again.");
                return;
            }
            this.#browserPage.refresh();
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
            <button class="clear-attempts-button">Clear Attempts</button>
            <button class="delete-button">Delete</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define("mock-test-options-context-menu", MockTestOptionsContextMenu);
export default MockTestOptionsContextMenu;
