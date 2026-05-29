import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class EnumFilterInput extends PaidDeckFilterInput
{
    #selectElement = null;

    render(container)
    {
        const metadata = this.getMetadata();
        const options = Array.isArray(metadata.options) ? metadata.options : [];

        const optionElements = options
            .map(option =>
            {
                const isObject = option && typeof option === "object";
                const optionValue = isObject ? option.value : option;
                const optionLabel = isObject ? option.label : String(option);
                return `<option value="${EnumFilterInput.#escape(String(optionValue))}">${EnumFilterInput.#escape(optionLabel)}</option>`;
            })
            .join("");

        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <select class="paid-deck-filter-enum-select">
                <option value="">Any</option>
                ${optionElements}
            </select>
        `;

        this.#selectElement = container.querySelector(".paid-deck-filter-enum-select");
        this.#selectElement.addEventListener("change", () => this.emitChange());
    }

    getValue()
    {
        if (this.#selectElement === null || this.#selectElement.value === "")
        {
            return undefined;
        }

        const rawValue = this.#selectElement.value;
        const numericValue = Number(rawValue);
        return Number.isNaN(numericValue) ? rawValue : numericValue;
    }

    clear()
    {
        if (this.#selectElement !== null)
        {
            this.#selectElement.value = "";
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

export default EnumFilterInput;
