import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import UserIdentityManager from "../../Globals/Classes/UserIdentityManager.js";
import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import PaidDeckFilterPanel from "./Components/PaidDeckFilterPanel.js";
import PaidDeckThumbnails from "../../Globals/Classes/PaidDeckThumbnails.js";
import PaidDeckRegistry from "../../Globals/Classes/PaidDeckRegistry.js";
import PaidDeckPurchaseFlow from "../../Globals/Classes/PaidDeckPurchaseFlow.js";
import RegionMetadata from "../../Globals/Classes/RegionMetadata.js";
import { paidDeckSortFields } from "../../Globals/Enumerations/PaidDeckSortFields.js";
import { sortDirections } from "../../Globals/Enumerations/SortDirections.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import TutorialDemoResponses from "../../Globals/Constants/TutorialDemoResponses.js";
import PopupStack from "../../Globals/Classes/PopupStack.js";

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

        // The marketplace belongs to the personal library: a purchase is a
        // personal transaction and its deck is seeded there. Refusing here as
        // well as hiding the entry point means a deep link or a stale page in
        // the navigation stack cannot get around it.
        if (UserIdentityManager.isOrganizationContext())
        {
            this.innerHTML = `
                <header-component title="Paid Deck Library"></header-component>
                <div class="paid-deck-library-empty">
                    The deck marketplace is part of your own library. Switch to viewing as
                    yourself from the profile menu to browse and buy decks.
                </div>
            `;
            return;
        }

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
                <button class="paid-deck-library-filters-toggle" type="button" data-role="filters-toggle" aria-expanded="false">
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3 5h18v2l-7 7v5l-4 2v-7L3 7z"></path></svg>
                    <span>Filters</span>
                </button>
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
                <div class="paid-deck-library-filter-backdrop" data-role="filter-backdrop" hidden></div>
                <div class="paid-deck-library-filter-drawer" data-role="filter-drawer">
                    <div class="paid-deck-library-filter-drawer-header">
                        <span>Filters</span>
                        <button class="paid-deck-library-filter-drawer-close" type="button" data-role="filter-drawer-close" aria-label="Close filters">✕</button>
                    </div>
                    <aside class="paid-deck-library-filter-panel" data-role="filter-panel">
                        <div class="paid-deck-filter-panel-loading">Loading filters…</div>
                    </aside>
                </div>
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
        this.#wireFilterDrawer();

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

    // The filter sidebar is a permanent column on desktop, but an off-canvas
    // drawer on narrow (mobile/portrait) screens so the deck grid keeps the
    // full width. The drawer's open state is driven purely by a class toggle;
    // the @media query decides whether that class has any visual effect.
    #wireFilterDrawer()
    {
        const toggleButton = this.querySelector('[data-role="filters-toggle"]');
        const backdrop = this.querySelector('[data-role="filter-backdrop"]');
        const closeButton = this.querySelector('[data-role="filter-drawer-close"]');

        // Track the drawer on the PopupStack while it is open so a global
        // Escape closes the drawer instead of navigating off the page. The
        // page-level keydown listener this replaced ran before the window
        // handler and cleared the open state too early, so Escape closed the
        // drawer AND still navigated back.
        let drawerPopupStackHandle = null;

        const setDrawerOpen = (isOpen) =>
        {
            this.classList.toggle("filter-drawer-open", isOpen);
            backdrop.hidden = !isOpen;
            toggleButton.setAttribute("aria-expanded", isOpen ? "true" : "false");

            if (isOpen)
            {
                if (drawerPopupStackHandle === null)
                {
                    drawerPopupStackHandle = PopupStack.register({ dismiss: () => setDrawerOpen(false) });
                }
            }
            else
            {
                PopupStack.unregister(drawerPopupStackHandle);
                drawerPopupStackHandle = null;
            }
        };

        toggleButton.addEventListener("click", () =>
        {
            setDrawerOpen(!this.classList.contains("filter-drawer-open"));
        });
        backdrop.addEventListener("click", () => setDrawerOpen(false));
        closeButton.addEventListener("click", () => setDrawerOpen(false));
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
        // Tutorial demo: don't fetch filter metadata from the server. An
        // empty filter set keeps the storefront usable for the walkthrough.
        if (TutorialEngine.isRunning())
        {
            this.#filterPanel.render([]);
            return;
        }

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

        // Tutorial demo: skip the /PaidDecks/Search call and render a single
        // bogus deck so the library / details / purchase flow can be shown
        // without contacting the server.
        if (TutorialEngine.isRunning())
        {
            this.#renderResults(TutorialDemoResponses.getPaidDeckSearchResult());
            return;
        }

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

            const isOwned = deck.computedPrice?.reason === "ALREADY_OWNED" || PaidDeckRegistry.isLicensed(deck.id);
            const ownership = PaidDeckLibraryPage.#getOwnershipExpiry(deck.id);

            // Owned decks show "Already purchased" in place of a price, plus an
            // "Extend" action for time-limited (subscription) access.
            const priceOrOwnedBlock = isOwned
                ? `<div class="paid-deck-card-owned">Already purchased</div>${ownership.expiryText ? `<div class="paid-deck-card-expiry">${PaidDeckLibraryPage.#escape(ownership.expiryText)}</div>` : ""}`
                : `<div class="paid-deck-card-price">${showStrike ? `<span class="paid-deck-card-strike">${currency} ${(baseMinor / 100).toFixed(2)}</span>` : ""}<span class="paid-deck-card-final">${currency} ${(finalMinor / 100).toFixed(2)}</span></div>`;

            const actionsBlock = (isOwned && ownership.hasExpiry)
                ? `<div class="paid-deck-card-actions"><button class="paid-deck-card-view" data-deck-index="${deckIndex}">View details</button><button class="paid-deck-card-extend" data-deck-index="${deckIndex}">Extend</button></div>`
                : `<button class="paid-deck-card-view" data-deck-index="${deckIndex}">View details</button>`;

            return `
                <div class="paid-deck-card" data-deck-index="${deckIndex}">
                    <div class="paid-deck-card-thumb-wrap">
                        <img class="paid-deck-card-thumb" src="${PaidDeckLibraryPage.#escape(PaidDeckThumbnails.resolveDeckThumbnail(deck))}" alt="" loading="lazy">
                    </div>
                    <div class="paid-deck-card-body">
                        <div class="paid-deck-card-title">${PaidDeckLibraryPage.#escape(deck.title)}</div>
                        <div class="paid-deck-card-description">${PaidDeckLibraryPage.#escape(deck.description || "")}</div>
                        ${priceOrOwnedBlock}
                        ${actionsBlock}
                    </div>
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

        for (const extendButton of this.querySelectorAll(".paid-deck-card-extend"))
        {
            extendButton.addEventListener("click", async (clickEvent) =>
            {
                // Don't let the click bubble to the card (which opens details).
                clickEvent.stopPropagation();
                const deckIndex = parseInt(extendButton.dataset.deckIndex, 10);
                if (!Number.isFinite(deckIndex)) return;

                extendButton.disabled = true;
                extendButton.textContent = "Working…";
                const extended = await PaidDeckPurchaseFlow.run(decks[deckIndex], this.#resolvedRegion || this.#manualRegion);
                if (extended)
                {
                    this.#runSearch();
                }
                else
                {
                    extendButton.disabled = false;
                    extendButton.textContent = "Extend";
                }
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

    /**
     * Reads the buyer's license expiry. Epoch-zero (1970) / far-future
     * sentinels mean lifetime access; a real future date is time-limited
     * (subscription) access that can be extended.
     */
    static #getOwnershipExpiry(deckId)
    {
        const license = PaidDeckRegistry.getLicense(deckId);
        if (!license || !license.expiresAt)
        {
            return { hasExpiry: false, expiryText: "" };
        }
        const expiryDate = new Date(license.expiresAt);
        if (isNaN(expiryDate.getTime()))
        {
            return { hasExpiry: false, expiryText: "" };
        }
        const expiryYear = expiryDate.getFullYear();
        if (expiryYear < 2001 || expiryYear > 9000)
        {
            return { hasExpiry: false, expiryText: "" };
        }
        const formatted = expiryDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
        return { hasExpiry: true, expiryText: `Access until ${formatted}` };
    }
}

customElements.define("paid-deck-library-page", PaidDeckLibraryPage);
export default PaidDeckLibraryPage;
