import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckFilterPanel from "./Components/PaidDeckFilterPanel.js";
import { paymentProviders } from "../../Globals/Enumerations/PaymentProviders.js";
import { paidDeckSortFields } from "../../Globals/Enumerations/PaidDeckSortFields.js";
import { sortDirections } from "../../Globals/Enumerations/SortDirections.js";

class PaidDeckLibraryPage extends HTMLElement
{
    static #SEARCH_ENDPOINT = "/PaidDecks/Search";
    static #FILTER_METADATA_ENDPOINT = "/PaidDecks/Filters";
    static #PAGE_SIZE = 24;
    static #QUERY_FILTER_KEY = "query";
    static #SEARCH_DEBOUNCE_MILLISECONDS = 250;

    #region = "IN";
    #filterPanel = null;
    #currentFilters = {};
    #currentSort = { field: paidDeckSortFields.PUBLISHED_AT, direction: sortDirections.DESCENDING };
    #currentOffset = 0;
    #latestSearchToken = 0;
    #searchDebounceTimeoutId = null;

    initialize(args)
    {
        if (args?.region)
        {
            this.#region = args.region;
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
                    Region: <strong>${this.#region}</strong>
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
                    region: this.#region,
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
            const currency = deck.currency || "INR";
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
                    <button class="paid-deck-card-buy" data-deck-index="${deckIndex}" ${deck.computedPrice?.reason === "ALREADY_OWNED" ? "disabled" : ""}>
                        ${deck.computedPrice?.reason === "ALREADY_OWNED" ? "Owned" : "Buy"}
                    </button>
                </div>
            `;
        }).join("");

        for (const buyButton of this.querySelectorAll(".paid-deck-card-buy"))
        {
            buyButton.addEventListener("click", (clickEvent) =>
            {
                const deckIndex = parseInt(clickEvent.currentTarget.dataset.deckIndex, 10);
                this.#initiatePurchase(decks[deckIndex]);
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

    async #initiatePurchase(deck)
    {
        if (!deck)
        {
            return;
        }

        let response;
        try
        {
            response = await fetch("/PaidDecks/Purchase/Initiate",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    deckIds: [deck.id],
                    region: this.#region,
                    paymentProvider: paymentProviders.RAZORPAY
                })
            });
        }
        catch (initiateError)
        {
            await DialogBox.alert("Error", `Network error: ${initiateError.message}`);
            return;
        }

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Purchase failed", responseJson.error || `HTTP ${response.status}`);
            return;
        }

        const responseJson = await response.json();

        if (responseJson.requiresPayment === false)
        {
            await DialogBox.alert("Acquired", "This deck has been added to your library.");
            await this.#runSearch();
            return;
        }

        await this.#openPaymentCheckout(deck, responseJson);
    }

    async #openPaymentCheckout(deck, initiateResponse)
    {
        const order = initiateResponse.order;
        const checkoutContext = order.checkoutContext;

        if (!window.Razorpay)
        {
            await DialogBox.alert
            (
                "Razorpay SDK missing",
                "The Razorpay checkout script is not loaded. Include https://checkout.razorpay.com/v1/checkout.js in your HTML."
            );
            return;
        }

        const options =
        {
            key: checkoutContext.keyId,
            amount: checkoutContext.amount,
            currency: checkoutContext.currency,
            order_id: checkoutContext.orderId,
            name: "MindMeld",
            description: deck.title,
            handler: async (razorpayResponse) =>
            {
                const verifyResponse = await fetch("/PaidDecks/Purchase/Verify",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        providerOrderId: razorpayResponse.razorpay_order_id,
                        providerPaymentId: razorpayResponse.razorpay_payment_id,
                        signature: razorpayResponse.razorpay_signature,
                        paymentProvider: initiateResponse.provider,
                        deckIds: [deck.id],
                        region: this.#region,
                        amountMinor: order.amountMinor,
                        currency: order.currency
                    })
                });

                if (verifyResponse.ok)
                {
                    await DialogBox.alert("Purchase complete", "Your deck has been added to your library.");
                    await this.#runSearch();
                }
                else
                {
                    const verifyJson = await verifyResponse.json().catch(() => ({}));
                    await DialogBox.alert("Verification failed", verifyJson.error || `HTTP ${verifyResponse.status}`);
                }
            }
        };

        const razorpayInstance = new window.Razorpay(options);
        razorpayInstance.open();
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
