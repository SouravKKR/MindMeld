import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import Deck from "../../Globals/Model/Deck.js";
import GenericSelection from "../../Globals/Classes/GenericSelection.js";
import { htmlToSearchableText } from "../../Globals/UtilityFunctions/HtmlToSearchableText.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";
import CardListItem from "./Components/CardListItem.js";
import StudyMaterialListItem from "./Components/StudyMaterialListItem.js";
import MockTestListItem from "./Components/MockTestListItem.js";

class BrowserPage extends HTMLElement
{
    #selection  = null;
    #deck       = null;
    #entityType = entityTypes.CARD;

    initialize(deck, entityType = entityTypes.CARD)
    {
        const onSelectElement   = (element) => { element.setAttribute("selected", ""); };
        const onDeselectElement = (element) => { element.removeAttribute("selected"); };

        this.#selection  = new GenericSelection(onSelectElement, onDeselectElement);
        this.#deck       = deck;
        this.#entityType = entityType;
    }

    getSelection()
    {
        return this.#selection;
    }

    #getEntities()
    {
        switch(this.#entityType)
        {
            case entityTypes.STUDY_MATERIAL: return this.#deck.getStudyMaterials(true);
            case entityTypes.MOCK_TEST:      return this.#deck.getMockTests(true);
            case entityTypes.CARD:           return this.#deck.getCards(true);
        }
    }

    #getEntityText(entity)
    {
        switch(this.#entityType)
        {
            case entityTypes.STUDY_MATERIAL: return htmlToSearchableText(entity.getContent());
            case entityTypes.MOCK_TEST:      return entity.getTitle();
            case entityTypes.CARD:           return htmlToSearchableText(entity.getQuestion());
        }
    }

    #createListItem(entity)
    {
        switch(this.#entityType)
        {
            case entityTypes.STUDY_MATERIAL:
            {
                const item = document.createElement("study-material-list-item");
                item.initialize(this, entity);
                return item;
            }
            case entityTypes.MOCK_TEST:
            {
                const item = document.createElement("mock-test-list-item");
                item.initialize(this, entity);
                return item;
            }
            case entityTypes.CARD:
            {
                const item = document.createElement("card-list-item");
                item.initialize(this, entity);
                return item;
            }
        }
    }

    #pageTitle()
    {
        const deckName = this.#deck.getName();

        switch(this.#entityType)
        {
            case entityTypes.STUDY_MATERIAL: return `${deckName} — Notes`;
            case entityTypes.MOCK_TEST:      return `${deckName} — Mock Tests`;
            case entityTypes.CARD:           return `${deckName} — Cards`;
        }
    }

    #setupUi()
    {
        const deckSelect = this.querySelector(".browser-deck-select");

        Deck.configureSearchableSelector(deckSelect, deck => true, Deck.getRoot(), this.#deck.getId(), "Select deck...");
        HeaderComponent.setTitle(this.#pageTitle());

        this.#search("");
    }

    #handleEvents()
    {
        const searchInput = this.querySelector(".entity-search-input");
        const deckSelect  = this.querySelector(".browser-deck-select");

        this.addEventListener("click", () =>
        {
            this.#selection.deselectAll();
        });

        deckSelect.addEventListener("change", () =>
        {
            this.#deck = Deck.getById(deckSelect.value);
            this.#setupUi();
        });

        searchInput.addEventListener("input", (event) =>
        {
            this.#search(event.target.value);
        });
    }

    #search(searchTerm = "")
    {
        this.#selection.deselectAll();

        const entities        = this.#getEntities();
        const listContainer   = this.querySelector(".entity-list-container");
        const lowerSearchTerm = searchTerm.toLowerCase();

        listContainer.innerHTML = "";

        for(const entity of entities)
        {
            if(lowerSearchTerm && !this.#getEntityText(entity).toLowerCase().includes(lowerSearchTerm))
            {
                continue;
            }

            listContainer.appendChild(this.#createListItem(entity));
        }
    }

    refresh()
    {
        this.#search(this.querySelector(".entity-search-input").value || "");
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="${this.#pageTitle()}"></header-component>
            <input type="text" placeholder="Search..." class="entity-search-input">
            <button type="button" class="browser-deck-select"></button>
            <div class="entity-list-container"></div>
        `;

        this.#setupUi();
        this.#handleEvents();
    }
}

customElements.define("browser-page", BrowserPage);
export default BrowserPage;
