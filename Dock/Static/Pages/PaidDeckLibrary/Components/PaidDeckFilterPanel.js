import PaidDeckFilterInputFactory from "./PaidDeckFilterInputFactory.js";

/**
 * PaidDeckFilterPanel
 *
 * Renders the entire filter sidebar from a list of metadata objects
 * served by /PaidDecks/Filters. The panel is intentionally dumb — it
 * knows nothing about which filters exist; it just instantiates the
 * right input class for each metadata entry and aggregates their
 * values when the user changes anything.
 *
 * Communication with the parent page is via:
 *   - onChange(filterValuesByKey) — fired on every input change.
 *   - getValues() / clearAll() — imperative methods for parent use.
 */
class PaidDeckFilterPanel
{
    #containerElement;
    #filterInputs = [];
    #onChangeCallback;

    constructor(containerElement, onChangeCallback)
    {
        if (!containerElement)
        {
            throw new Error("PaidDeckFilterPanel requires a container element");
        }

        this.#containerElement = containerElement;
        this.#onChangeCallback = typeof onChangeCallback === "function" ? onChangeCallback : null;
    }

    render(filterMetadataList)
    {
        this.#containerElement.innerHTML = "";
        this.#filterInputs = [];

        if (!Array.isArray(filterMetadataList) || filterMetadataList.length === 0)
        {
            this.#containerElement.innerHTML = `<div class="paid-deck-filter-panel-empty">No filters configured.</div>`;
            return;
        }

        const headerElement = document.createElement("div");
        headerElement.className = "paid-deck-filter-panel-header";
        headerElement.innerHTML = `
            <span>Filters</span>
            <button class="paid-deck-filter-panel-clear" type="button">Clear all</button>
        `;
        this.#containerElement.appendChild(headerElement);

        headerElement
            .querySelector(".paid-deck-filter-panel-clear")
            .addEventListener("click", () => this.clearAll());

        for (const metadata of filterMetadataList)
        {
            const filterContainer = document.createElement("div");
            filterContainer.className = "paid-deck-filter-panel-field";
            filterContainer.dataset.filterKey = metadata.key;

            const filterInput = PaidDeckFilterInputFactory.create(metadata, (filterKey, value) =>
            {
                this.#handleInputChange();
            });

            if (filterInput === null)
            {
                continue;
            }

            filterInput.render(filterContainer);
            this.#containerElement.appendChild(filterContainer);
            this.#filterInputs.push(filterInput);
        }
    }

    #handleInputChange()
    {
        if (this.#onChangeCallback !== null)
        {
            this.#onChangeCallback(this.getValues());
        }
    }

    getValues()
    {
        const filterValuesByKey = {};

        for (const filterInput of this.#filterInputs)
        {
            const value = filterInput.getValue();
            if (value !== undefined)
            {
                filterValuesByKey[filterInput.getKey()] = value;
            }
        }

        return filterValuesByKey;
    }

    clearAll()
    {
        for (const filterInput of this.#filterInputs)
        {
            filterInput.clear();
        }
        this.#handleInputChange();
    }
}

export default PaidDeckFilterPanel;
