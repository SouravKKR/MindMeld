import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class TextSearchFilterInput extends PaidDeckFilterInput
{
    static #DEBOUNCE_MILLISECONDS = 250;

    #inputElement = null;
    #debounceTimeoutId = null;

    render(container)
    {
        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <input type="search" class="paid-deck-filter-text-input" placeholder="Search by title, description, tags...">
        `;

        this.#inputElement = container.querySelector(".paid-deck-filter-text-input");

        this.#inputElement.addEventListener("input", () =>
        {
            clearTimeout(this.#debounceTimeoutId);
            this.#debounceTimeoutId = setTimeout(() => this.emitChange(), TextSearchFilterInput.#DEBOUNCE_MILLISECONDS);
        });

        this.#inputElement.addEventListener("keydown", (keyEvent) =>
        {
            if (keyEvent.key === "Enter")
            {
                clearTimeout(this.#debounceTimeoutId);
                this.emitChange();
            }
        });
    }

    getValue()
    {
        if (this.#inputElement === null)
        {
            return "";
        }

        const trimmed = this.#inputElement.value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }

    clear()
    {
        if (this.#inputElement !== null)
        {
            this.#inputElement.value = "";
        }
    }
}

export default TextSearchFilterInput;
