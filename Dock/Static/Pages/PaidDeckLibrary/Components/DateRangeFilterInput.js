import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class DateRangeFilterInput extends PaidDeckFilterInput
{
    #fromInputElement = null;
    #toInputElement = null;

    render(container)
    {
        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <div class="paid-deck-filter-date-range">
                <input type="date" class="paid-deck-filter-date-from">
                <span class="paid-deck-filter-range-separator">–</span>
                <input type="date" class="paid-deck-filter-date-to">
            </div>
        `;

        this.#fromInputElement = container.querySelector(".paid-deck-filter-date-from");
        this.#toInputElement = container.querySelector(".paid-deck-filter-date-to");

        this.#fromInputElement.addEventListener("change", () => this.emitChange());
        this.#toInputElement.addEventListener("change", () => this.emitChange());
    }

    getValue()
    {
        if (this.#fromInputElement === null || this.#toInputElement === null)
        {
            return undefined;
        }

        const fromValue = this.#fromInputElement.value;
        const toValue = this.#toInputElement.value;

        if (!fromValue && !toValue)
        {
            return undefined;
        }

        const dateRangeValue = {};
        if (fromValue) dateRangeValue.from = new Date(fromValue).toISOString();
        if (toValue) dateRangeValue.to = new Date(toValue).toISOString();
        return dateRangeValue;
    }

    clear()
    {
        if (this.#fromInputElement !== null) this.#fromInputElement.value = "";
        if (this.#toInputElement !== null) this.#toInputElement.value = "";
    }
}

export default DateRangeFilterInput;
