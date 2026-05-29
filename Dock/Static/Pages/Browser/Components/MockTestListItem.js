import MockTestOptionsContextMenu from "./MockTestOptionsContextMenu.js";

class MockTestListItem extends HTMLElement
{
    #browserPage = null;
    #mockTest    = null;

    initialize(browserPage, mockTest)
    {
        this.#browserPage = browserPage;
        this.#mockTest    = mockTest;
    }

    #handleEvents()
    {
        const optionsButton = this.querySelector(".entity-options-button");

        optionsButton.addEventListener("click", (event) =>
        {
            event.stopPropagation();
            MockTestOptionsContextMenu.create(
                { x: event.clientX, y: event.clientY },
                this.#mockTest,
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
                const lastSelection = this.#browserPage.getSelection().getLastSelectedItem();
                const indexOfLast   = Array.from(container.children).indexOf(lastSelection);
                const indexOfThis   = Array.from(container.children).indexOf(this);
                const start         = Math.min(indexOfLast, indexOfThis);
                const end           = Math.max(indexOfLast, indexOfThis);

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
        this.innerHTML =
        `
            <div class="entity-text-container">${this.#mockTest.getTitle() || "(untitled)"}</div>
            <button class="entity-options-button">...</button>
        `;

        this.#handleEvents();
    }
}

customElements.define("mock-test-list-item", MockTestListItem);
export default MockTestListItem;
