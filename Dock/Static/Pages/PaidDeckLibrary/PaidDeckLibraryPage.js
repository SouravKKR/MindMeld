import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import PaidDeckFilterPanel from "./Components/PaidDeckFilterPanel.js";
import RegionMetadata from "../../Globals/Classes/RegionMetadata.js";
import { paidDeckSortFields } from "../../Globals/Enumerations/PaidDeckSortFields.js";
import { sortDirections } from "../../Globals/Enumerations/SortDirections.js";

class PaidDeckLibraryPage extends HTMLElement
{
    static #SEARCH_ENDPOINT = "/PaidDecks/Search";
    static #FILTER_METADATA_ENDPOINT = "/PaidDecks/Filters";
    static #PAGE_SIZE = 24;
    static #QUERY_FILTER_KEY = "query";
    static #SEARCH_DEBOUNCE_MILLISECONDS = 250;
    static #REGION_STORAGE_KEY = "paidDeckLibrary.manualRegion";

    // null => auto-detect (backend resolves via CF-IPCountry / locale hint).
    // A region code => the buyer's explicit manual override.
    #manualRegion = null;
    #resolvedRegion = null;
    #filterPanel = null;
    #currentFilters = {};
    #currentSort = { field: paidDeckSortFields.PUBLISHED_AT, direction: sortDirections.DESCENDING };
    #currentOffset = 0;
    #latestSearchToken = 0;
    #searchDebounceTimeoutId = null;

    initialize(args)
    {
        // Explicit arg wins; otherwise restore the buyer's last manual pick.
        if (args?.region && RegionMetadata.isValidRegion(args.region))
        {
            this.#manualRegion = args.region;
            return;
        }
        try
        {
            const stored = window.localStorage.getItem(PaidDeckLibraryPage.#REGION_STORAGE_KEY);
            if (RegionMetadata.isValidRegion(stored))
            {
                this.#manualRegion = stored;
            }
        }
        catch (storageError)
        {
            // Storage unavailable — stay on auto-detect.
        }
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML = `
            <header-component title="Paid Deck Library"></header-component>
            <div class="paid-deck-library-controls">
                <div class="paid-deck-library-search">
                    <input
                        type="search"
                        class="paid-deck-library-search-input"
                        placeholder="Search decks by title, description, category, or tags"
                        autocomplete="off"
                        spellcheck="false">
                    <button class="paid-deck-library-search-clear" type="button" hidden>Clear</button>
                </div>
                <div class="paid-deck-library-region-bar">
                    <label>Region</label>
                    <select class="paid-deck-library-region-select">
                        <option value="">Auto-detect</option>
                        ${RegionMetadata.getAllRegions().map((region) => `<option value="${region.code}"${this.#manualRegion === region.code ? " selected" : ""}>${PaidDeckLibraryPage.#escape(region.label)} (${PaidDeckLibraryPage.#escape(region.currency)})</option>`).join("")}
                    </select>
                    <span class="paid-deck-library-region-resolved" data-role="region-resolved"></span>
                </div>
                <div class="paid-deck-library-sort">
                    <label>Sort by</label>
                    <select class="paid-deck-library-sort-field">
                        <option value="${paidDeckSortFields.PUBLISHED_AT}">Upload date</option>
                        <option value="${paidDeckSortFields.TITLE}">Title</option>
                        <option value="${paidDeckSortFields.BASE_PRICE_MINOR}">Price</option>
                        <option value="${paidDeckSortFields.CATEGORY}">Category</option>
                    </select>
                    <select class="paid-deck-library-sort-direction">
                        <option value="${sortDirections.DESCENDING}">Descending</option>
                        <option value="${sortDirections.ASCENDING}">Ascending</option>
                    </select>
                </div>
            </div>
            <div class="paid-deck-library-body">
                <aside class="paid-deck-library-filter-panel" data-role="filter-panel">
                    <div class="paid-deck-filter-panel-loading">Loading filters…</div>
                </aside>
                <main class="paid-deck-library-results">
                    <div class="paid-deck-library-result-count" data-role="result-count"></div>
                    <div class="paid-deck-library-grid" data-role="grid">
                        <div class="paid-deck-library-loading">Loading…</div>
                    </div>
                    <div class="paid-deck-library-pagination" data-role="pagination"></div>
                </main>
            </div>
        `;

        this.#wireSearchBar();

        this.querySelector(".paid-deck-library-sort-field").addEventListener("change", (changeEvent) =>
        {
            this.#currentSort.field = Number(changeEvent.currentTarget.value);
            this.#currentOffset = 0;
            this.#runSearch();
        });

        this.querySelector(".paid-deck-library-sort-direction").addEventListener("change", (changeEvent) =>
        {
            this.#currentSort.direction = Number(changeEvent.currentTarget.value);
            this.#currentOffset = 0;
            this.#runSearch();
        });

        this.querySelector(".paid-deck-library-region-select").addEventListener("change", (changeEvent) =>
        {
            const picked = changeEvent.currentTarget.value;
            this.#manualRegion = RegionMetadata.isValidRegion(picked) ? picked : null;
            try
            {
                if (this.#manualRegion)
                {
                    window.localStorage.setItem(PaidDeckLibraryPage.#REGION_STORAGE_KEY, this.#manualRegion);
                }
                else
                {
                    window.localStorage.removeItem(PaidDeckLibraryPage.#REGION_STORAGE_KEY);
                }
            }
            catch (storageError)
            {
                // Non-fatal — the pick still applies for this session.
            }
            this.#currentOffset = 0;
            this.#runSearch();
        });

        const filterPanelContainer = this.querySelector('[data-role="filter-panel"]');
        this.#filterPanel = new PaidDeckFilterPanel(filterPanelContainer, (filterValues) =>
        {
            this.#currentFilters = filterValues;
            this.#currentOffset = 0;
            this.#runSearch();
        });

        await this.#loadFilterMetadata();
        await this.#runSearch();
    }

    #wireSearchBar()
    {
        const searchInputElement = this.querySelector(".paid-deck-library-search-input");
        const searchClearButton = this.querySelector(".paid-deck-library-search-clear");

        searchInputElement.addEventListener("input", (inputEvent) =>
        {
            const rawValue = inputEvent.currentTarget.value;
            const trimmedQuery = rawValue.trim();

            searchClearButton.hidden = rawValue.length === 0;

            if (this.#searchDebounceTimeoutId !== null)
            {
                clearTimeout(this.#searchDebounceTimeoutId);
            }

            this.#searchDebounceTimeoutId = setTimeout(() =>
            {
                this.#searchDebounceTimeoutId = null;
                this.#applyQueryFilter(trimmedQuery);
            }, PaidDeckLibraryPage.#SEARCH_DEBOUNCE_MILLISECONDS);
        });

        searchInputElement.addEventListener("keydown", (keyDownEvent) =>
        {
            if (keyDownEvent.key !== "Enter")
            {
                return;
            }

            if (this.#searchDebounceTimeoutId !== null)
            {
                clearTimeout(this.#searchDebounceTimeoutId);
                this.#searchDebounceTimeoutId = null;
            }

            this.#applyQueryFilter(keyDownEvent.currentTarget.value.trim());
        });

        searchClearButton.addEventListener("click", () =>
        {
            searchInputElement.value = "";
            searchClearButton.hidden = true;

            if (this.#searchDebounceTimeoutId !== null)
            {
                clearTimeout(this.#searchDebounceTimeoutId);
                this.#searchDebounceTimeoutId = null;
            }

            this.#applyQueryFilter("");
            searchInputElement.focus();
        });
    }

    #applyQueryFilter(trimmedQuery)
    {
        if (trimmedQuery.length === 0)
        {
            delete this.#currentFilters[PaidDeckLibraryPage.#QUERY_FILTER_KEY];
        }
        else
        {
            this.#currentFilters[PaidDeckLibraryPage.#QUERY_FILTER_KEY] = trimmedQuery;
        }

        this.#currentOffset = 0;
        this.#runSearch();
    }

    async #loadFilterMetadata()
    {
        try
        {
            const response = await fetch(PaidDeckLibraryPage.#FILTER_METADATA_ENDPOINT);

            if (!response.ok)
            {
                this.#filterPanel.render([]);
                return;
            }

            const responseJson = await response.json();
            const rawFilterMetadataList = Array.isArray(responseJson.filters) ? responseJson.filters : [];
            const sidebarFilterMetadataList = rawFilterMetadataList.filter((filterMetadata) =>
            {
                return filterMetadata.key !== PaidDeckLibraryPage.#QUERY_FILTER_KEY;
            });
            this.#filterPanel.render(sidebarFilterMetadataList);
        }
        catch (loadError)
        {
            console.warn("[PaidDeckLibraryPage] Failed to load filter metadata:", loadError);
            this.#filterPanel.render([]);
        }
    }

    async #runSearch()
    {
        const grid = this.querySelector('[data-role="grid"]');
        const resultCount = this.querySelector('[data-role="result-count"]');
        const pagination = this.querySelector('[data-role="pagination"]');

        grid.innerHTML = `<div class="paid-deck-library-loading">Searching…</div>`;

        this.#latestSearchToken++;
        const searchToken = this.#latestSearchToken;

        try
        {
            const response = await fetch(PaidDeckLibraryPage.#SEARCH_ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    filters: this.#currentFilters,
                    sort: this.#currentSort,
                    region: this.#manualRegion,
                    localeRegionHint: RegionMetadata.guessRegionFromLocale(),
                    limit: PaidDeckLibraryPage.#PAGE_SIZE,
                    offset: this.#currentOffset
                })
            });

            // Drop stale responses — a faster newer search may have
            // already updated the grid by the time this one returns.
            if (searchToken !== this.#latestSearchToken)
            {
                return;
            }

            if (!response.ok)
            {
                grid.innerHTML = `<div class="paid-deck-library-error">Search failed (${response.status}).</div>`;
                resultCount.textContent = "";
                pagination.innerHTML = "";
                return;
            }

            const responseJson = await response.json();
            this.#renderResults(responseJson);
        }
        catch (searchError)
        {
            if (searchToken !== this.#latestSearchToken)
            {
                return;
            }
            grid.innerHTML = `<div class="paid-deck-library-error">${searchError.message}</div>`;
            resultCount.textContent = "";
            pagination.innerHTML = "";
        }
    }

    #renderResults(searchResult)
    {
        const grid = this.querySelector('[data-role="grid"]');
        const resultCount = this.querySelector('[data-role="result-count"]');
        const pagination = this.querySelector('[data-role="pagination"]');

        const decks = Array.isArray(searchResult.decks) ? searchResult.decks : [];

        // Reflect the region the backend actually priced against (useful in
        // auto-detect mode, where the buyer didn't pick one explicitly).
        this.#resolvedRegion = searchResult.region || null;
        const resolvedElement = this.querySelector('[data-role="region-resolved"]');
        if (resolvedElement)
        {
            resolvedElement.textContent = (!this.#manualRegion && this.#resolvedRegion)
                ? `Showing prices for ${RegionMetadata.getLabel(this.#resolvedRegion)}`
                : "";
        }

        resultCount.textContent = `${searchResult.totalCount || 0} deck${searchResult.totalCount === 1 ? "" : "s"} found`;

        if (decks.length === 0)
        {
            grid.innerHTML = `<div class="paid-deck-library-empty">No decks match the current filters.</div>`;
            pagination.innerHTML = "";
            return;
        }

        grid.innerHTML = decks.map((deck, deckIndex) =>
        {
            const finalMinor = deck.computedPrice?.finalPriceMinor ?? deck.basePriceMinor ?? 0;
            const baseMinor = deck.computedPrice?.basePriceMinor ?? deck.basePriceMinor ?? 0;
            const showStrike = baseMinor > 0 && finalMinor < baseMinor;
            // Prefer the per-deck currency the pricing engine stamped (already
            // converted into the buyer region's display currency).
            const currency = deck.computedPrice?.currency || deck.currency || "INR";
            const ownedNote = deck.computedPrice?.reason === "ALREADY_OWNED"
                ? `<div class="paid-deck-card-owned">Already owned</div>`
                : "";

            return `
                <div class="paid-deck-card" data-deck-index="${deckIndex}">
                    <img class="paid-deck-card-thumb" src="${PaidDeckLibraryPage.#escape(deck.thumbnailUrl || '/Globals/Assets/Images/Icons/DeckIcon.svg')}" alt="">
                    <div class="paid-deck-card-title">${PaidDeckLibraryPage.#escape(deck.title)}</div>
                    <div class="paid-deck-card-description">${PaidDeckLibraryPage.#escape(deck.description || "")}</div>
                    <div class="paid-deck-card-price">
                        ${showStrike ? `<span class="paid-deck-card-strike">${currency} ${(baseMinor / 100).toFixed(2)}</span>` : ""}
                        <span class="paid-deck-card-final">${currency} ${(finalMinor / 100).toFixed(2)}</span>
                    </div>
                    ${ownedNote}
                    <button class="paid-deck-card-view" data-deck-index="${deckIndex}">View details</button>
                </div>
            `;
        }).join("");

        for (const card of this.querySelectorAll(".paid-deck-card"))
        {
            card.addEventListener("click", (clickEvent) =>
            {
                const deckIndex = parseInt(card.dataset.deckIndex, 10);
                if (!Number.isFinite(deckIndex)) return;
                PageNavigator.open("paid-deck-details-page", decks[deckIndex], this.#resolvedRegion || this.#manualRegion);
                clickEvent.stopPropagation();
            });
        }

        this.#renderPagination(searchResult);
    }

    #renderPagination(searchResult)
    {
        const pagination = this.querySelector('[data-role="pagination"]');
        const totalCount = searchResult.totalCount || 0;
        const currentOffset = searchResult.offset || 0;
        const pageSize = searchResult.limit || PaidDeckLibraryPage.#PAGE_SIZE;
        const hasPrevious = currentOffset > 0;
        const hasNext = currentOffset + pageSize < totalCount;

        if (!hasPrevious && !hasNext)
        {
            pagination.innerHTML = "";
            return;
        }

        const currentPage = Math.floor(currentOffset / pageSize) + 1;
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

        pagination.innerHTML = `
            <button class="paid-deck-library-page-previous" ${hasPrevious ? "" : "disabled"}>Previous</button>
            <span class="paid-deck-library-page-counter">Page ${currentPage} of ${totalPages}</span>
            <button class="paid-deck-library-page-next" ${hasNext ? "" : "disabled"}>Next</button>
        `;

        pagination.querySelector(".paid-deck-library-page-previous").addEventListener("click", () =>
        {
            this.#currentOffset = Math.max(0, currentOffset - pageSize);
            this.#runSearch();
        });
        pagination.querySelector(".paid-deck-library-page-next").addEventListener("click", () =>
        {
            this.#currentOffset = currentOffset + pageSize;
            this.#runSearch();
        });
    }

    static #escape(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("paid-deck-library-page", PaidDeckLibraryPage);
export default PaidDeckLibraryPage;
