import { htmlToSearchableText } from "../../../Globals/UtilityFunctions/HtmlToSearchableText.js";
import CardOptionsContextMenu from "./CardOptionsContextMenu.js";
class CardListItem extends HTMLElement
{
    #browserPage = null;
    #card = null;

    static create(browserPage, card)
    {
        const cardListItemElement = document.createElement('card-list-item');
        cardListItemElement.initialize(browserPage, card);
        return cardListItemElement;
    }

    initialize(browserPage, card)
    {
        this.#browserPage = browserPage;
        this.#card = card;
    }

    #handleEvents()
    {
        const cardOptionsButton = this.querySelector(".card-options-button");
        
        cardOptionsButton.addEventListener("click", (event) => 
        {
            event.stopPropagation();
            CardOptionsContextMenu.create({ x: event.clientX, y: event.clientY }, this.#card, this.#browserPage);
        });

        this.addEventListener("click", (event) => 
        {
            const entityListContainer = this.#browserPage.querySelector(".entity-list-container");

            event.stopPropagation();
            
            if(event.ctrlKey)
            {
                this.#browserPage.getSelection().toggleSelection([this]);
            }
            else if(event.shiftKey)
            {
                const lastSelection = this.#browserPage.getSelection().getLastSelectedItem();
                const indexOfLastSelection = Array.from(entityListContainer.children).indexOf(lastSelection);
                const indexOfThis = Array.from(entityListContainer.children).indexOf(this);
                const start = Math.min(indexOfLastSelection, indexOfThis);
                const end = Math.max(indexOfLastSelection, indexOfThis);

                this.#browserPage.getSelection().addSelection([...entityListContainer.children].slice(start, end + 1));
            }
            else
            {
                this.#browserPage.getSelection().deselectAll();
                this.#browserPage.getSelection().addSelection([this]);
            }

        });
    }

    connectedCallback()
    {
        this.innerHTML = 
        `
            
            <div class="question-text-container">${htmlToSearchableText(this.#card.getQuestion())}</div>
            <button class="card-options-button">...</button>
        `;
        
        this.#handleEvents();
    }
}

customElements.define("card-list-item", CardListItem);
export default CardListItem;