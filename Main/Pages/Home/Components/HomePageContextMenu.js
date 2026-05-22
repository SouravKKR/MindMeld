import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import Deck from "../../../Globals/Model/Deck.js";

class HomePageContextMenu extends ContextMenu
{
    static tagName = 'home-page-context-menu';

    #deck = null;
    initialize(position = { x: 0, y: 0 })
    {
        super.initialize(position);
        this.#deck = Deck.getCurrentDeck();
    }

    #handleEvents()
    {
        const createDeckButton = this.querySelector('.create-deck-button');
        const importDeckButton = this.querySelector('.import-deck-button');

        importDeckButton.addEventListener('click', () =>
        {
            this.#deck.import();
        });
    }

    connectedCallback()
    {
        this.innerHTML = 
        `
            <button class="create-deck-button">Create Deck</button>
            <button class="import-deck-button">Import</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define('home-page-context-menu', HomePageContextMenu);
export default HomePageContextMenu;