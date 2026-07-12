import PopupStack from "../Globals/Classes/PopupStack.js";

class ContextMenu extends HTMLElement
{
    #resizeObserver = null;
    #position = { x: 0, y: 0 };
    #popupStackHandle = null;

    static create(position = { x: 0, y: 0 }, ...args)
    {
        this.removeAll();

        const tagName = this.tagName;
        const contextMenuElement = document.createElement(tagName);

        contextMenuElement.initialize(position, ...args);
        document.body.appendChild(contextMenuElement);

        document.body.addEventListener(
            "click",
            () => contextMenuElement.remove(),
            { once: true }
        );

        return contextMenuElement;
    }

    static removeAll()
    {
        document
            .querySelectorAll(this.tagName)
            .forEach(element => element.remove());
    }

    initialize(position = { x: 0, y: 0 })
    {
        this.#position = position;

        this.style.left = `${position.x}px`;
        this.style.top  = `${position.y}px`;

        this.classList.add("context-menu");
    }


    #correctPosition()
    {
        const rect = this.getBoundingClientRect();

        let left = this.#position.x;
        let top  = this.#position.y;

        if ((left + rect.width) > window.innerWidth)
        {
            left = left - rect.width;
        }

        if ((top + rect.height) > window.innerHeight)
        {
            top = top - rect.height;
        }

        this.style.left = `${Math.max(0, left)}px`;
        this.style.top  = `${Math.max(0, top)}px`;
    }

    connectedCallback()
    {
        this.querySelectorAll(":scope > *").forEach((element) =>
        {
            element.classList.add("context-menu-item");
        });

        this.#resizeObserver = new ResizeObserver(() =>
        {
            this.#correctPosition();
        });

        this.#resizeObserver.observe(this);

        // Escape closes the menu instead of navigating the page away. An
        // open context menu otherwise only dismisses on an outside click.
        this.#popupStackHandle = PopupStack.register(
        {
            dismiss: () => this.remove()
        });
    }

    disconnectedCallback()
    {
        this.#resizeObserver?.disconnect();

        PopupStack.unregister(this.#popupStackHandle);
        this.#popupStackHandle = null;
    }
}

customElements.define("context-menu", ContextMenu);
export default ContextMenu;
