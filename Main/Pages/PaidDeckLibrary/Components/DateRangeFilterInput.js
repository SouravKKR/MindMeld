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

    setValue(value)
    {
        if (this.#fromInputElement === null || this.#toInputElement === null)
        {
            return;
        }

        // A date input only accepts YYYY-MM-DD, so the stored ISO instant is
        // trimmed to its date part rather than rejected wholesale.
        this.#fromInputElement.value = DateRangeFilterInput.#toDateInputValue(value?.from);
        this.#toInputElement.value = DateRangeFilterInput.#toDateInputValue(value?.to);
    }

    static #toDateInputValue(isoString)
    {
        if (typeof isoString !== "string" || isoString.length === 0)
        {
            return "";
        }

        const parsedDate = new Date(isoString);
        return Number.isNaN(parsedDate.getTime()) ? "" : parsedDate.toISOString().slice(0, 10);
    }
}

export default DateRangeFilterInput;
