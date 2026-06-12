import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import Deck from "../../Globals/Model/Deck.js";
import GenericSelection from "../../Globals/Classes/GenericSelection.js";
import MockTestAttemptCleaner from "../../Globals/Classes/MockTestAttemptCleaner.js";
import { htmlToSearchableText } from "../../Globals/UtilityFunctions/HtmlToSearchableText.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";
import CardListItem from "./Components/CardListItem.js";
import StudyMaterialListItem from "./Components/StudyMaterialListItem.js";
import MockTestListItem from "./Components/MockTestListItem.js";
import PaidDeckStudyGate from "../../Globals/Classes/PaidDeckStudyGate.js";

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
        const clearMockTestAttemptsButton = this.querySelector(".browser-clear-mock-test-attempts-button");

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

        if (clearMockTestAttemptsButton)
        {
            clearMockTestAttemptsButton.addEventListener("click", async (clickEvent) =>
            {
                // The page-level click handler above deselects everything;
                // stop propagation so opening the confirm dialog doesn't
                // also blow away the selection state we don't care about.
                clickEvent.stopPropagation();
                const result = await MockTestAttemptCleaner.clearForDeck(this.#deck);
                if (result.cleared > 0)
                {
                    this.refresh();
                }
            });
        }
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
        this.#renderWhenReady();
    }

    async #renderWhenReady()
    {
        // A paid deck must be unlocked + decrypted once this session before its
        // cards / materials are listed, or every row (and the search index)
        // would read the [Locked] placeholder instead of real content. No-op
        // for a normal deck. If the user cancels the unlock, show a locked
        // notice rather than a list of placeholders.
        const bReady = await PaidDeckStudyGate.ensureReadyForStudy(this.#deck);
        if (!bReady)
        {
            this.setAttribute("page", "");
            this.innerHTML = `<header-component title="Locked"></header-component>`;
            return;
        }

        this.setAttribute("page", "");

        const showClearAttemptsButton = this.#entityType === entityTypes.MOCK_TEST;

        this.innerHTML =
        `
            <header-component title="${this.#pageTitle()}"></header-component>
            <input type="text" placeholder="Search..." class="entity-search-input">
            <button type="button" class="browser-deck-select"></button>
            ${showClearAttemptsButton ? `<button type="button" class="browser-clear-mock-test-attempts-button">Clear Mock Test Attempts</button>` : ""}
            <div class="entity-list-container"></div>
        `;

        this.#setupUi();
        this.#handleEvents();
    }
}

customElements.define("browser-page", BrowserPage);
export default BrowserPage;
