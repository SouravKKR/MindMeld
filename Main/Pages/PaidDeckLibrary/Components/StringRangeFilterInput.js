import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

/**
 * StringRangeFilterInput
 *
 * The text counterpart to NumberRangeFilterInput: an inclusive start–end span
 * over a text field, so a range selection can be expressed over names, roll
 * numbers or streams rather than only over numbers and dates.
 *
 * Both ends are inclusive and either may be left blank for an open end. The
 * server compares case-insensitively, so what is typed here need not match the
 * casing in the data.
 */
class StringRangeFilterInput extends PaidDeckFilterInput
{
    static #DEBOUNCE_MILLISECONDS = 300;

    #startInputElement = null;
    #endInputElement = null;
    #debounceTimeoutId = null;

    render(container)
    {
        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <div class="paid-deck-filter-number-range">
                <input type="text" class="paid-deck-filter-range-start" placeholder="From" autocomplete="off" spellcheck="false">
                <span class="paid-deck-filter-range-separator">–</span>
                <input type="text" class="paid-deck-filter-range-end" placeholder="To" autocomplete="off" spellcheck="false">
            </div>
        `;

        this.#startInputElement = container.querySelector(".paid-deck-filter-range-start");
        this.#endInputElement = container.querySelector(".paid-deck-filter-range-end");

        const debouncedEmit = () =>
        {
            clearTimeout(this.#debounceTimeoutId);
            this.#debounceTimeoutId = setTimeout(() => this.emitChange(), StringRangeFilterInput.#DEBOUNCE_MILLISECONDS);
        };

        this.#startInputElement.addEventListener("input", debouncedEmit);
        this.#endInputElement.addEventListener("input", debouncedEmit);
    }

    getValue()
    {
        if (this.#startInputElement === null || this.#endInputElement === null)
        {
            return undefined;
        }

        const startValue = this.#startInputElement.value.trim();
        const endValue = this.#endInputElement.value.trim();

        if (startValue.length === 0 && endValue.length === 0)
        {
            return undefined;
        }

        const rangeValue = {};
        if (startValue.length > 0)
        {
            rangeValue.start = startValue;
        }
        if (endValue.length > 0)
        {
            rangeValue.end = endValue;
        }
        return rangeValue;
    }

    clear()
    {
        if (this.#startInputElement !== null)
        {
            this.#startInputElement.value = "";
        }
        if (this.#endInputElement !== null)
        {
            this.#endInputElement.value = "";
        }
    }
}

export default StringRangeFilterInput;
