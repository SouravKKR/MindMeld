import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class MultiSelectFilterInput extends PaidDeckFilterInput
{
    #checkboxElements = [];

    /**
     * Accepts either shape a filter may declare its options in: a bare string,
     * or a { value, label } pair for a filter whose stored value is not what a
     * person should read.
     *
     * Normalised here rather than required of every filter author, because the
     * failure mode when they disagree is not an error — it is a checkbox list
     * reading "[object Object]", which renders happily and means nothing.
     */
    static #normaliseOption(option)
    {
        if (option !== null && typeof option === "object")
        {
            const value = option.value !== undefined && option.value !== null ? String(option.value) : "";
            const label = option.label !== undefined && option.label !== null ? String(option.label) : value;
            return { value: value, label: label };
        }

        const stringValue = String(option);
        return { value: stringValue, label: stringValue };
    }

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
            .map(option => MultiSelectFilterInput.#normaliseOption(option))
            .map(option => `
                <label class="paid-deck-filter-checkbox-row">
                    <input type="checkbox" data-value="${MultiSelectFilterInput.#escape(option.value)}" class="paid-deck-filter-checkbox">
                    <span>${MultiSelectFilterInput.#escape(option.label)}</span>
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
