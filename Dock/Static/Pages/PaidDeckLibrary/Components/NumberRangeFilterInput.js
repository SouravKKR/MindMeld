import PaidDeckFilterInput from "./PaidDeckFilterInput.js";

class NumberRangeFilterInput extends PaidDeckFilterInput
{
    static #DEBOUNCE_MILLISECONDS = 300;

    #minInputElement = null;
    #maxInputElement = null;
    #debounceTimeoutId = null;

    render(container)
    {
        const metadata = this.getMetadata();
        const stepAttribute = metadata.step ? `step="${metadata.step}"` : "";
        const minBound = metadata.defaultMin !== null && metadata.defaultMin !== undefined ? metadata.defaultMin : "";
        const maxBound = metadata.defaultMax !== null && metadata.defaultMax !== undefined ? metadata.defaultMax : "";

        container.innerHTML = `
            <label class="paid-deck-filter-label">${this.getLabel()}</label>
            <div class="paid-deck-filter-number-range">
                <input type="number" class="paid-deck-filter-range-min" placeholder="Min" ${stepAttribute}>
                <span class="paid-deck-filter-range-separator">–</span>
                <input type="number" class="paid-deck-filter-range-max" placeholder="Max" ${stepAttribute}>
            </div>
            <div class="paid-deck-filter-range-bounds">${minBound !== "" ? `${minBound} – ${maxBound}` : ""}</div>
        `;

        this.#minInputElement = container.querySelector(".paid-deck-filter-range-min");
        this.#maxInputElement = container.querySelector(".paid-deck-filter-range-max");

        const debouncedEmit = () =>
        {
            clearTimeout(this.#debounceTimeoutId);
            this.#debounceTimeoutId = setTimeout(() => this.emitChange(), NumberRangeFilterInput.#DEBOUNCE_MILLISECONDS);
        };

        this.#minInputElement.addEventListener("input", debouncedEmit);
        this.#maxInputElement.addEventListener("input", debouncedEmit);
    }

    getValue()
    {
        if (this.#minInputElement === null || this.#maxInputElement === null)
        {
            return undefined;
        }

        const minString = this.#minInputElement.value;
        const maxString = this.#maxInputElement.value;

        const parsedMin = minString === "" ? null : Number(minString);
        const parsedMax = maxString === "" ? null : Number(maxString);

        const hasMin = parsedMin !== null && Number.isFinite(parsedMin);
        const hasMax = parsedMax !== null && Number.isFinite(parsedMax);

        if (!hasMin && !hasMax)
        {
            return undefined;
        }

        const rangeValue = {};
        if (hasMin) rangeValue.min = parsedMin;
        if (hasMax) rangeValue.max = parsedMax;
        return rangeValue;
    }

    clear()
    {
        if (this.#minInputElement !== null) this.#minInputElement.value = "";
        if (this.#maxInputElement !== null) this.#maxInputElement.value = "";
    }
}

export default NumberRangeFilterInput;
