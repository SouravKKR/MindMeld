import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class MultiSelectFilterInput extends PaidDeckFilterInput
{
    #checkboxElements = [];

    render(container)
    {
        const metadata = this.getMetadata();
        const options = Array.isArray(metadata.options) ? metadata.options : [];

        if (options.length === 0)
        {
            container.innerHTML = `
                <label class="paid-deck-filter-label">${this.getLabel()}</label>
                <div class="paid-deck-filter-empty">No options available yet.</div>
            `;
            this.#checkboxElements = [];
            return;
        }

        const checkboxRows = options
            .map(option => `
                <label class="paid-deck-filter-checkbox-row">
                    <input type="checkbox" data-value="${MultiSelectFilterInput.#escape(String(option))}" class="paid-deck-filter-checkbox">
                    <span>${MultiSelectFilterInput.#escape(String(option))}</span>
                </label>
            `)
            .join("");

        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <div class="paid-deck-filter-checkbox-list">${checkboxRows}</div>
        `;

        this.#checkboxElements = Array.from(container.querySelectorAll(".paid-deck-filter-checkbox"));

        for (const checkboxElement of this.#checkboxElements)
        {
            checkboxElement.addEventListener("change", () => this.emitChange());
        }
    }

    getValue()
    {
        const selectedValues = this.#checkboxElements
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.dataset.value);

        return selectedValues.length > 0 ? selectedValues : undefined;
    }

    clear()
    {
        for (const checkboxElement of this.#checkboxElements)
        {
            checkboxElement.checked = false;
        }
    }

    static #escape(rawString)
    {
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default MultiSelectFilterInput;
