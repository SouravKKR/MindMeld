import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";

class CardOptionsContextMenu extends ContextMenu
{
    #card = null;
    #position = { x: 0, y: 0 };
    #browserPage = null;

    static tagName = "card-options-context-menu";

    initialize(position = { x: 0, y: 0 }, card, browserPage)
    {
        super.initialize(position);

        this.#card = card;
        this.#browserPage = browserPage;
    }

    #handleEvents()
    {
        const editButton = this.querySelector(".edit-button");
        const resetButton = this.querySelector(".reset-button");
        const deleteButton = this.querySelector(".delete-button");

        editButton.addEventListener("click", (event) => 
        {
            PageNavigator.open("card-editor-page", this.#card, this.#card.getDeck());
        });

        resetButton.addEventListener("click", async () => 
        {
            const result = await DialogBox.confirm("Reset Card", "Are you sure you want to reset this card?<br><br>This action will erase all progress made on this card.");
            
            if(!result) return;
        
            await this.#card.reset();
        });

        deleteButton.addEventListener("click", async () => 
        {
            const result = await DialogBox.confirm("Delete Card", "Are you sure you want to delete this card?<br><br>This action cannot be undone.");
            
            if(!result) return;

            this.#card.delete()

            this.#browserPage.refresh();
        });
    }


    connectedCallback()
    {
        this.innerHTML = 
        `
            <button class="edit-button">Edit</button>
            <button class="reset-button">Reset</button>
            <button class="delete-button">Delete</button>
        `;

        super.connectedCallback();
        this.#handleEvents();

    }
}

customElements.define("card-options-context-menu", CardOptionsContextMenu);
export default CardOptionsContextMenu;