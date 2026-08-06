import Deck from "../../../Globals/Model/Deck.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import UserIdentityManager from "../../../Globals/Classes/UserIdentityManager.js";
import DeckTile from "./DeckTile.js";
import CreateDeckChoiceModal from "../../../CommonComponents/CreateDeckChoiceModal.js";
import DeckCreationChoiceAvailability from "../../../Globals/Classes/DeckCreationChoiceAvailability.js";
import { deckCreationOptions } from "../../../Globals/Enumerations/DeckCreationOptions.js";

class NewDeckTile extends DeckTile
{

    static create()
    {
        const newDeckTileElement = document.createElement('new-deck-tile');
        return newDeckTileElement;
    }

    #openDeckEditor()
    {
        PageNavigator.open("deck-editor-page", null, Deck.getCurrentDeck());
    }

    async #handleClick()
    {
        if (!DeckCreationChoiceAvailability.bShouldShowChoiceModal())
        {
            this.#openDeckEditor();
            return;
        }

        const choice = await CreateDeckChoiceModal.show();

        if (choice === deckCreationOptions.CREATE_NEW_DECK)
        {
            this.#openDeckEditor();
        }
        else if (choice === deckCreationOptions.BROWSE_PAID_LIBRARY)
        {
            PageNavigator.open("paid-deck-library-page");
        }
        else if (choice === deckCreationOptions.BROWSE_ORGANIZATION_SHELF)
        {
            PageNavigator.open("organization-shelf-page", UserIdentityManager.getOrganizationContextId());
        }
        else if (choice === deckCreationOptions.IMPORT_FROM_FILE)
        {
            await Deck.getCurrentDeck().import();
        }
    }

    #handleEvents()
    {
        this.addEventListener("click", () =>
        {
            this.#handleClick();
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="new-deck-tile">+</div>
        `;

        this.#handleEvents();
    }
}

customElements.define('new-deck-tile', NewDeckTile);
export default NewDeckTile;
