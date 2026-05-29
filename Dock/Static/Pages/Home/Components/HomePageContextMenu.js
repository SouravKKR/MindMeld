import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import Deck from "../../../Globals/Model/Deck.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";

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
        const insightsButton   = this.querySelector('.insights-button');
        const createDeckButton = this.querySelector('.create-deck-button');
        const importDeckButton = this.querySelector('.import-deck-button');

        insightsButton.addEventListener('click', () =>
        {
            // Right-clicking the home page itself targets the root deck —
            // the user has no specific deck in scope here, so we surface
            // the aggregate insights (mastery + heatmap + topics across
            // every sub-deck).
            const rootDeck = Deck.getRoot();
            if (!rootDeck)
            {
                return;
            }
            PageNavigator.open('deck-insights-page', rootDeck);
            HomePageContextMenu.removeAll();
        });

        importDeckButton.addEventListener('click', () =>
        {
            this.#deck.import();
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="insights-button">Insights</button>
            <button class="create-deck-button">Create Deck</button>
            <button class="import-deck-button">Import</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define('home-page-context-menu', HomePageContextMenu);
export default HomePageContextMenu;