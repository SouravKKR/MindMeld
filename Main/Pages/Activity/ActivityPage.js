import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import PausedTaskBanner from "../../CommonComponents/PausedTaskBanner.js";
import ActivityEntryComponent from "./Components/ActivityEntryComponent.js";
import LocalDownloadActivitySource from "./Sources/LocalDownloadActivitySource.js";
import PaidDeckUploadActivitySource from "./Sources/PaidDeckUploadActivitySource.js";
import { activityEntryTypes } from "../../Globals/Enumerations/ActivityEntryTypes.js";
import { activitySortFields } from "../../Globals/Enumerations/ActivitySortFields.js";
import { taskStatus } from "../../Globals/Enumerations/TaskStatus.js";
import BrowserLlmDownloadEvents from "../../Globals/Events/BrowserLlmDownloadEvents.js";
import PaidDeckUploadEvents from "../../Globals/Events/PaidDeckUploadEvents.js";


/**
 * ActivityPage
 *
 * Full-screen view of a user's tasks + purchases. Three primary
 * controls along the top:
 *   1. Search input (debounced) — free-text match against entry title.
 *   2. Tabs — Tasks | Purchases | All (drives the `includeTypes` body).
 *   3. Sort dropdown — TIMESTAMP newest-first by default.
 *
 * Side panel: status filter and an optional date range. Kept minimal
 * deliberately — the search bar covers most needs and we already let
 * the filter registry on Dock evolve.
 *
 * Results render as <activity-entry-component> rows, each carrying
 * its own action button (View / Invoice).
 */
class ActivityPage extends HTMLElement
{
    static #ENDPOINT = "/Activity/Search";
    static #SEARCH_DEBOUNCE_MILLIS = 250;
    static #PAGE_SIZE = 50;

    #currentSearchQuery = "";
    #currentStatusFilter = null;
    #currentTimestampFrom = "";
    #currentTimestampUntil = "";
    #currentSortField = activitySortFields.TIMESTAMP;
    #currentSortDirection = -1;
    #currentIncludeTypes = [activityEntryTypes.TASK, activityEntryTypes.PURCHASE, activityEntryTypes.DOWNLOAD, activityEntryTypes.UPLOAD];
    #currentOffset = 0;
    #latestSearchToken = 0;
    #searchDebounceTimeoutId = null;
    #boundCapabilityChangedHandler = null;
    #boundProgressHandler = null;
    #boundUploadProgressHandler = null;
    #lastUploadEntryPresent = false;

    async connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML = `
            <header-component title="Activity"></header-component>
            <paused-task-banner></paused-task-banner>
            <div class="activity-page-controls">
                <div class="activity-page-search">
                    <input
                        type="search"
                        class="activity-page-search-input"
                        placeholder="Search activity by title"
                        autocomplete="off"
                        spellcheck="false">
                    <button type="button" class="activity-page-search-clear" hidden>Clear</button>
                </div>
                <div class="activity-page-tabs" data-role="tabs">
                    <button type="button" class="activity-page-tab activity-page-tab-active" data-types="all">All</button>
                    <button type="button" class="activity-page-tab" data-types="tasks">Tasks</button>
                    <button type="button" class="activity-page-tab" data-types="purchases">Purchases</button>
                    <button type="button" class="activity-page-tab" data-types="downloads">Downloads</button>
                </div>
                <div class="activity-page-sort">
                    <label>Sort by</label>
                    <select class="activity-page-sort-field">
                        <option value="${activitySortFields.TIMESTAMP}">Date</option>
                        <option value="${activitySortFields.TYPE}">Type</option>
                        <option value="${activitySortFields.STATUS}">Status</option>
                        <option value="${activitySortFields.TITLE}">Title</option>
                    </select>
                    <select class="activity-page-sort-direction">
                        <option value="-1">Descending</option>
                        <option value="1">Ascending</option>
                    </select>
                </div>
            </div>
            <div class="activity-page-body">
                <aside class="activity-page-filters">
                    <div class="activity-page-filter-header">Filters</div>
                    <div class="activity-page-filter-field">
                        <label class="activity-page-filter-label">Task status</label>
                        <select class="activity-page-status-filter">
                            <option value="">Any</option>
                            <option value="${taskStatus.IN_PROGRESS}">In progress</option>
                            <option value="${taskStatus.COMPLETED}">Completed</option>
                            <option value="${taskStatus.FAILED}">Failed</option>
                        </select>
                    </div>
                    <div class="activity-page-filter-field">
                        <label class="activity-page-filter-label">From</label>
                        <input type="date" class="activity-page-from-filter">
                    </div>
                    <div class="activity-page-filter-field">
                        <label class="activity-page-filter-label">Until</label>
                        <input type="date" class="activity-page-until-filter">
                    </div>
                    <button type="button" class="activity-page-clear-filters">Clear filters</button>
                </aside>
                <main class="activity-page-results">
                    <div class="activity-page-result-count" data-role="result-count"></div>
                    <div class="activity-page-list" data-role="list">
                        <div class="activity-page-loading">Loading…</div>
                    </div>
                    <div class="activity-page-pagination" data-role="pagination"></div>
                </main>
            </div>
        `;

        this.#wireSearchBar();
        this.#wireTabs();
        this.#wireSortControls();
        this.#wireFilterPanel();
        this.#wireDownloadStateListeners();

        await this.#runSearch();
    }

    disconnectedCallback()
    {
        if (this.#boundCapabilityChangedHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundCapabilityChangedHandler);
            this.#boundCapabilityChangedHandler = null;
        }
        if (this.#boundProgressHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.PROGRESS, this.#boundProgressHandler);
            this.#boundProgressHandler = null;
        }
        if (this.#boundUploadProgressHandler)
        {
            window.removeEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);
            this.#boundUploadProgressHandler = null;
        }
    }

    #wireDownloadStateListeners()
    {
        // Re-render on capability transitions so the Downloads entry
        // appears / disappears / changes status without the user having
        // to click the tab again. Progress ticks would be too noisy at
        // a full re-render rate, so we only listen for state changes
        // here; ActivityEntryComponent picks up live progress on its
        // own subscription.
        this.#boundCapabilityChangedHandler = () =>
        {
            this.#runSearch();
        };
        window.addEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundCapabilityChangedHandler);

        // Paid-deck upload: re-run search only when the entry appears or
        // disappears (so the row enters/leaves the list). Per-% updates are
        // handled by ActivityEntryComponent's own subscription, so we avoid a
        // full re-search (and its loading flicker) on every tick.
        this.#boundUploadProgressHandler = () =>
        {
            const present = PaidDeckUploadActivitySource.getEntry() !== null;
            if (present !== this.#lastUploadEntryPresent)
            {
                this.#lastUploadEntryPresent = present;
                this.#runSearch();
            }
        };
        window.addEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);
    }

    #wireSearchBar()
    {
        const searchInputElement = this.querySelector(".activity-page-search-input");
        const searchClearButton = this.querySelector(".activity-page-search-clear");

        searchInputElement.addEventListener("input", (inputEvent) =>
        {
            const rawValue = inputEvent.currentTarget.value;
            searchClearButton.hidden = rawValue.length === 0;

            if (this.#searchDebounceTimeoutId !== null)
            {
                clearTimeout(this.#searchDebounceTimeoutId);
            }
            this.#searchDebounceTimeoutId = setTimeout(() =>
            {
                this.#searchDebounceTimeoutId = null;
                this.#currentSearchQuery = rawValue.trim();
                this.#currentOffset = 0;
                this.#runSearch();
            }, ActivityPage.#SEARCH_DEBOUNCE_MILLIS);
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
            this.#currentSearchQuery = keyDownEvent.currentTarget.value.trim();
            this.#currentOffset = 0;
            this.#runSearch();
        });

        searchClearButton.addEventListener("click", () =>
        {
            searchInputElement.value = "";
            searchClearButton.hidden = true;
            this.#currentSearchQuery = "";
            this.#currentOffset = 0;
            this.#runSearch();
            searchInputElement.focus();
        });
    }

    #wireTabs()
    {
        const tabButtons = this.querySelectorAll(".activity-page-tab");
        for (const tabButton of tabButtons)
        {
            tabButton.addEventListener("click", () =>
            {
                for (const sibling of tabButtons)
                {
                    sibling.classList.toggle("activity-page-tab-active", sibling === tabButton);
                }

                const typesAttribute = tabButton.getAttribute("data-types");
                if (typesAttribute === "tasks")
                {
                    this.#currentIncludeTypes = [activityEntryTypes.TASK];
                }
                else if (typesAttribute === "purchases")
                {
                    this.#currentIncludeTypes = [activityEntryTypes.PURCHASE];
                }
                else if (typesAttribute === "downloads")
                {
                    this.#currentIncludeTypes = [activityEntryTypes.DOWNLOAD];
                }
                else
                {
                    this.#currentIncludeTypes = [activityEntryTypes.TASK, activityEntryTypes.PURCHASE, activityEntryTypes.DOWNLOAD, activityEntryTypes.UPLOAD];
                }

                this.#currentOffset = 0;
                this.#runSearch();
            });
        }
    }

    #wireSortControls()
    {
        this.querySelector(".activity-page-sort-field").addEventListener("change", (changeEvent) =>
        {
            this.#currentSortField = Number(changeEvent.currentTarget.value);
            this.#currentOffset = 0;
            this.#runSearch();
        });
        this.querySelector(".activity-page-sort-direction").addEventListener("change", (changeEvent) =>
        {
            this.#currentSortDirection = Number(changeEvent.currentTarget.value);
            this.#currentOffset = 0;
            this.#runSearch();
        });
    }

    #wireFilterPanel()
    {
        this.querySelector(".activity-page-status-filter").addEventListener("change", (changeEvent) =>
        {
            const rawValue = changeEvent.currentTarget.value;
            this.#currentStatusFilter = rawValue === "" ? null : Number(rawValue);
            this.#currentOffset = 0;
            this.#runSearch();
        });
        this.querySelector(".activity-page-from-filter").addEventListener("change", (changeEvent) =>
        {
            this.#currentTimestampFrom = changeEvent.currentTarget.value;
            this.#currentOffset = 0;
            this.#runSearch();
        });
        this.querySelector(".activity-page-until-filter").addEventListener("change", (changeEvent) =>
        {
            this.#currentTimestampUntil = changeEvent.currentTarget.value;
            this.#currentOffset = 0;
            this.#runSearch();
        });
        this.querySelector(".activity-page-clear-filters").addEventListener("click", () =>
        {
            this.#currentStatusFilter = null;
            this.#currentTimestampFrom = "";
            this.#currentTimestampUntil = "";
            this.querySelector(".activity-page-status-filter").value = "";
            this.querySelector(".activity-page-from-filter").value = "";
            this.querySelector(".activity-page-until-filter").value = "";
            this.#currentOffset = 0;
            this.#runSearch();
        });
    }

    #buildRequestBody()
    {
        const filters = {};
        if (this.#currentSearchQuery.length > 0)
        {
            filters.query = this.#currentSearchQuery;
        }
        if (this.#currentStatusFilter !== null)
        {
            filters.status = this.#currentStatusFilter;
        }
        if (this.#currentTimestampFrom.length > 0 || this.#currentTimestampUntil.length > 0)
        {
            filters.timestamp = {};
            if (this.#currentTimestampFrom.length > 0)
            {
                filters.timestamp.from = this.#currentTimestampFrom;
            }
            if (this.#currentTimestampUntil.length > 0)
            {
                filters.timestamp.until = this.#currentTimestampUntil;
            }
        }

        // DOWNLOAD is a client-only entry type — strip it before the
        // request so the server doesn't see an unknown enum value. The
        // local source's entry is spliced in client-side after the
        // server returns.
        const serverSideIncludeTypes = this.#currentIncludeTypes.filter((entryType) =>
        {
            return entryType !== activityEntryTypes.DOWNLOAD;
        });

        return {
            filters: filters,
            sort: { field: this.#currentSortField, direction: this.#currentSortDirection },
            limit: ActivityPage.#PAGE_SIZE,
            offset: this.#currentOffset,
            includeTypes: serverSideIncludeTypes
        };
    }

    async #runSearch()
    {
        const listElement = this.querySelector('[data-role="list"]');
        const resultCountElement = this.querySelector('[data-role="result-count"]');
        const paginationElement = this.querySelector('[data-role="pagination"]');

        listElement.innerHTML = `<div class="activity-page-loading">Searching…</div>`;

        this.#latestSearchToken++;
        const searchToken = this.#latestSearchToken;

        const requestBody = this.#buildRequestBody();
        const bSkipServerCall = Array.isArray(requestBody.includeTypes) && requestBody.includeTypes.length === 0;

        try
        {
            // Downloads-only tab: no point hitting the server — the
            // local-download source is the sole entry contributor.
            let responseJson;
            if (bSkipServerCall)
            {
                responseJson = { entries: [], totalCount: 0, offset: 0, limit: ActivityPage.#PAGE_SIZE };
            }
            else
            {
                const response = await fetch(ActivityPage.#ENDPOINT,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                });

                if (searchToken !== this.#latestSearchToken)
                {
                    return;
                }

                if (!response.ok)
                {
                    listElement.innerHTML = `<div class="activity-page-error">Search failed (${response.status}).</div>`;
                    resultCountElement.textContent = "";
                    paginationElement.innerHTML = "";
                    return;
                }

                responseJson = await response.json();
            }

            this.#renderResults(responseJson);
        }
        catch (searchError)
        {
            if (searchToken !== this.#latestSearchToken)
            {
                return;
            }
            listElement.innerHTML = `<div class="activity-page-error">${searchError.message}</div>`;
            resultCountElement.textContent = "";
            paginationElement.innerHTML = "";
        }
    }

    #spliceLocalDownloadEntry(responseJson)
    {
        if (!LocalDownloadActivitySource.matchesIncludeTypes(this.#currentIncludeTypes))
        {
            return responseJson;
        }

        const localEntry = LocalDownloadActivitySource.getEntry();
        if (!localEntry)
        {
            return responseJson;
        }

        // Free-text filter: skip the splice if the user typed a query
        // that doesn't match the local entry's title.
        if (this.#currentSearchQuery.length > 0
            && !localEntry.title.toLowerCase().includes(this.#currentSearchQuery.toLowerCase()))
        {
            return responseJson;
        }

        const entries = Array.isArray(responseJson.entries) ? responseJson.entries.slice() : [];
        // Live downloads belong at the top of the list — they're the
        // user's most recent / most relevant activity.
        entries.unshift(localEntry);

        return {
            ...responseJson,
            entries,
            totalCount: (responseJson.totalCount || 0) + 1
        };
    }

    #spliceLocalUploadEntry(responseJson)
    {
        if (!PaidDeckUploadActivitySource.matchesIncludeTypes(this.#currentIncludeTypes))
        {
            return responseJson;
        }

        const localEntry = PaidDeckUploadActivitySource.getEntry();
        if (!localEntry)
        {
            return responseJson;
        }

        if (this.#currentSearchQuery.length > 0
            && !localEntry.title.toLowerCase().includes(this.#currentSearchQuery.toLowerCase()))
        {
            return responseJson;
        }

        const entries = Array.isArray(responseJson.entries) ? responseJson.entries.slice() : [];
        entries.unshift(localEntry);

        return {
            ...responseJson,
            entries,
            totalCount: (responseJson.totalCount || 0) + 1
        };
    }

    #renderResults(rawResponseJson)
    {
        const responseJson = this.#spliceLocalUploadEntry(this.#spliceLocalDownloadEntry(rawResponseJson));

        const listElement = this.querySelector('[data-role="list"]');
        const resultCountElement = this.querySelector('[data-role="result-count"]');
        const paginationElement = this.querySelector('[data-role="pagination"]');

        const entries = Array.isArray(responseJson.entries) ? responseJson.entries : [];
        const totalCount = responseJson.totalCount || 0;

        resultCountElement.textContent = totalCount === 0
            ? "No matching activity yet."
            : `${totalCount} entr${totalCount === 1 ? "y" : "ies"} found`;

        if (entries.length === 0)
        {
            listElement.innerHTML = `<div class="activity-page-empty">Nothing here yet.</div>`;
            paginationElement.innerHTML = "";
            return;
        }

        listElement.innerHTML = "";
        for (const entry of entries)
        {
            const entryElement = document.createElement("activity-entry-component");
            entryElement.initialize(entry);
            listElement.appendChild(entryElement);
        }

        this.#renderPagination(responseJson);
    }

    #renderPagination(responseJson)
    {
        const paginationElement = this.querySelector('[data-role="pagination"]');
        const totalCount = responseJson.totalCount || 0;
        const currentOffset = responseJson.offset || 0;
        const pageSize = responseJson.limit || ActivityPage.#PAGE_SIZE;
        const hasPrevious = currentOffset > 0;
        const hasNext = currentOffset + pageSize < totalCount;

        if (!hasPrevious && !hasNext)
        {
            paginationElement.innerHTML = "";
            return;
        }

        const currentPage = Math.floor(currentOffset / pageSize) + 1;
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

        paginationElement.innerHTML = `
            <button type="button" class="activity-page-page-previous" ${hasPrevious ? "" : "disabled"}>Previous</button>
            <span class="activity-page-page-counter">Page ${currentPage} of ${totalPages}</span>
            <button type="button" class="activity-page-page-next" ${hasNext ? "" : "disabled"}>Next</button>
        `;

        paginationElement.querySelector(".activity-page-page-previous").addEventListener("click", () =>
        {
            this.#currentOffset = Math.max(0, currentOffset - pageSize);
            this.#runSearch();
        });
        paginationElement.querySelector(".activity-page-page-next").addEventListener("click", () =>
        {
            this.#currentOffset = currentOffset + pageSize;
            this.#runSearch();
        });
    }
}

customElements.define("activity-page", ActivityPage);
export default ActivityPage;
