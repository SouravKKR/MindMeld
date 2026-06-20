import { htmlToSearchableText } from "../../../Globals/UtilityFunctions/HtmlToSearchableText.js";
import StudyMaterialOptionsContextMenu from "./StudyMaterialOptionsContextMenu.js";

class StudyMaterialListItem extends HTMLElement
{
    #browserPage = null;
    #material = null;

    initialize(browserPage, material)
    {
        this.#browserPage = browserPage;
        this.#material    = material;
    }

    #handleEvents()
    {
        const optionsButton = this.querySelector(".entity-options-button");

        optionsButton.addEventListener("click", (event) =>
        {
            event.stopPropagation();
            StudyMaterialOptionsContextMenu.create(
                { x: event.clientX, y: event.clientY },
                this.#material,
                this.#browserPage
            );
        });

        this.addEventListener("click", (event) =>
        {
            const container = this.#browserPage.querySelector(".entity-list-container");

            event.stopPropagation();

            if(event.ctrlKey)
            {
                this.#browserPage.getSelection().toggleSelection([this]);
            }
            else if(event.shiftKey)
            {
                const lastSelection     = this.#browserPage.getSelection().getLastSelectedItem();
                const indexOfLast       = Array.from(container.children).indexOf(lastSelection);
                const indexOfThis       = Array.from(container.children).indexOf(this);
                const start             = Math.min(indexOfLast, indexOfThis);
                const end               = Math.max(indexOfLast, indexOfThis);

                this.#browserPage.getSelection().addSelection([...container.children].slice(start, end + 1));
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
        const preview = htmlToSearchableText(this.#material.getContent()).substring(0, 140);

        this.innerHTML =
        `
            <div class="entity-text-container">${preview || "(empty)"}</div>
            <button class="entity-options-button">...</button>
        `;

        this.#handleEvents();
    }
}

customElements.define("study-material-list-item", StudyMaterialListItem);
export default StudyMaterialListItem;
