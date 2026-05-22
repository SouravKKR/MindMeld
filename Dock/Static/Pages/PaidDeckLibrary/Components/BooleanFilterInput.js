import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class BooleanFilterInput extends PaidDeckFilterInput
{
    #selectElement = null;

    render(container)
    {
        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <select class="paid-deck-filter-boolean-select">
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
            </select>
        `;

        this.#selectElement = container.querySelector(".paid-deck-filter-boolean-select");
        this.#selectElement.addEventListener("change", () => this.emitChange());
    }

    getValue()
    {
        if (this.#selectElement === null || this.#selectElement.value === "")
        {
            return undefined;
        }

        return this.#selectElement.value === "true";
    }

    clear()
    {
        if (this.#selectElement !== null)
        {
            this.#selectElement.value = "";
        }
    }
}

export default BooleanFilterInput;
