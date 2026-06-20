import AdminListFilterInputFactory from "./AdminListFilterInputFactory.js";

/**
 * AdminListView  <admin-list-view>
 *
 * A reusable server-paginated list: data table + search box + filter inputs +
 * entry-limit selector + pagination. Every admin tab configures it with its
 * listKey (served by /Admin/Lists/Metadata + /Admin/Lists/Query) or a
 * customFetcher, plus row/bulk actions; the rest is generalized.
 *
 * Usage:
 *   const listView = document.createElement("admin-list-view");
 *   container.appendChild(listView);
 *   listView.configure
 *   ({
 *       listKey: adminListTypes.RELEASE_NOTES,
 *       rowActions: [ { actionKey: "edit", label: "Edit" }, { actionKey: "delete", label: "Delete" } ],
 *       onRowAction: (actionKey, rowId, row) => { ... },
 *       onLoaded: (items, totalCount) => { ... }
 *   });
 *
 * rowActions may be an array or a function(row) => array, so a tab can show
 * per-row conditional actions (e.g. Publish vs Unpublish). After a mutation,
 * call listView.refresh() to re-fetch the current page.
 */
class AdminListView extends HTMLElement
{
    #config = null;
    #metadata = null;
    #filterInputs = [];

    #searchText = "";
    #filterValues = {};
    #sort = null;
    #limit = 50;
    #offset = 0;

    #items = [];
    #totalCount = 0;
    #selectedRowIds = new Set();
    #searchDebounceTimer = null;
    #isLoading = false;
    #pendingRefetch = false;

    configure(config)
    {
        this.#config = config || {};
        this.#selectedRowIds.clear();
        this.#offset = 0;

        if (this.isConnected)
        {
            this.#initialize();
        }
    }

    connectedCallback()
    {
        if (this.#config && !this.#metadata)
        {
            this.#initialize();
        }
    }

    setRequestContext(requestContext)
    {
        this.#config.requestContext = requestContext || {};
        this.#selectedRowIds.clear();
        this.#offset = 0;
        this.refresh();
    }

    async #initialize()
    {
        this.innerHTML = `<div class="admin-list-view"><div class="admin-list-status">Loading…</div></div>`;

        try
        {
            this.#metadata = await this.#loadMetadata();
        }
        catch (metadataError)
        {
            console.error("[AdminListView] Failed to load metadata:", metadataError);
            this.innerHTML = `<div class="admin-list-view"><div class="admin-list-status admin-list-error">Failed to load list configuration.</div></div>`;
            return;
        }

        this.#limit = Number(this.#metadata.defaultLimit) || 50;
        this.#sort = this.#metadata.defaultSort || null;
        this.#filterValues = {};

        this.#renderShell();
        await this.#fetchPage();
    }

    async #loadMetadata()
    {
        if (typeof this.#config.customFetcher === "function")
        {
            return {
                columns: this.#config.columns || [],
                searchEnabled: !!this.#config.searchEnabled,
                searchPlaceholder: this.#config.searchPlaceholder || "Search…",
                filters: [],
                defaultSort: this.#config.defaultSort || null,
                defaultLimit: this.#config.defaultLimit || 50,
                limitOptions: this.#config.limitOptions || [25, 50, 100, 200],
                rowIdField: this.#config.rowIdField || "id"
            };
        }

        const response = await fetch(`/Admin/Lists/Metadata?listKey=${encodeURIComponent(this.#config.listKey)}`, { credentials: "include" });
        if (!response.ok)
        {
            throw new Error(`Metadata request failed with status ${response.status}`);
        }
        return await response.json();
    }

    #renderShell()
    {
        const columns = this.#getColumns();
        const limitOptions = this.#metadata.limitOptions || [25, 50, 100, 200];

        const headerCells = columns.map(column => `<th>${this.#escapeHtml(column.label)}</th>`).join("");
        const selectAllCell = this.#config.selectable ? `<th class="admin-list-checkbox-cell"><input type="checkbox" data-role="select-all"></th>` : "";
        const actionsHeaderCell = this.#hasRowActions() ? `<th></th>` : "";

        const searchControl = this.#metadata.searchEnabled
            ? `<input type="search" class="admin-list-search" data-role="search" placeholder="${this.#escapeHtml(this.#metadata.searchPlaceholder || "Search…")}">`
            : "";

        const bulkBar = this.#hasBulkActions()
            ? `<div class="admin-list-bulk-bar" data-role="bulk-bar">${this.#config.bulkActions.map(action => `<button class="admin-list-bulk-button" data-bulk-action="${this.#escapeHtml(action.actionKey)}" disabled>${this.#escapeHtml(action.label)} (0)</button>`).join("")}</div>`
            : "";

        this.innerHTML = `
            <div class="admin-list-view">
                <div class="admin-list-toolbar">
                    ${searchControl}
                    <div class="admin-list-filters" data-role="filters"></div>
                    <label class="admin-list-limit">
                        Show
                        <select data-role="limit">
                            ${limitOptions.map(option => `<option value="${option}" ${option === this.#limit ? "selected" : ""}>${option}</option>`).join("")}
                        </select>
                    </label>
                </div>
                ${bulkBar}
                <div class="admin-list-table-wrap">
                    <table class="admin-list-table">
                        <thead>
                            <tr>${selectAllCell}${headerCells}${actionsHeaderCell}</tr>
                        </thead>
                        <tbody data-role="rows"></tbody>
                    </table>
                </div>
                <div class="admin-list-footer">
                    <div class="admin-list-count" data-role="count"></div>
                    <div class="admin-list-pagination">
                        <button class="admin-list-page-button" data-role="previous" disabled>Previous</button>
                        <button class="admin-list-page-button" data-role="next" disabled>Next</button>
                    </div>
                </div>
            </div>
        `;

        this.#renderFilterInputs();
        this.#bindShellEvents();
    }

    #renderFilterInputs()
    {
        const filtersContainer = this.querySelector('[data-role="filters"]');
        if (!filtersContainer)
        {
            return;
        }

        this.#filterInputs = [];
        for (const filterMetadata of (this.#metadata.filters || []))
        {
            const filterInput = AdminListFilterInputFactory.create(filterMetadata, (key, value) =>
            {
                this.#filterValues[key] = value;
                this.#offset = 0;
                this.#fetchPage();
            });

            if (!filterInput)
            {
                continue;
            }

            const wrapper = document.createElement("div");
            wrapper.className = "admin-list-filter";
            filterInput.render(wrapper);
            filtersContainer.appendChild(wrapper);
            this.#filterInputs.push(filterInput);
        }
    }

    #bindShellEvents()
    {
        const searchInput = this.querySelector('[data-role="search"]');
        if (searchInput)
        {
            searchInput.addEventListener("input", (inputEvent) =>
            {
                this.#searchText = inputEvent.currentTarget.value;
                if (this.#searchDebounceTimer !== null)
                {
                    clearTimeout(this.#searchDebounceTimer);
                }
                this.#searchDebounceTimer = setTimeout(() =>
                {
                    this.#offset = 0;
                    this.#fetchPage();
                }, 250);
            });
        }

        const limitSelect = this.querySelector('[data-role="limit"]');
        if (limitSelect)
        {
            limitSelect.addEventListener("change", (changeEvent) =>
            {
                this.#limit = Number(changeEvent.currentTarget.value) || 50;
                this.#offset = 0;
                this.#fetchPage();
            });
        }

        const previousButton = this.querySelector('[data-role="previous"]');
        if (previousButton)
        {
            previousButton.addEventListener("click", () =>
            {
                if (this.#offset <= 0)
                {
                    return;
                }
                this.#offset = Math.max(this.#offset - this.#limit, 0);
                this.#fetchPage();
            });
        }

        const nextButton = this.querySelector('[data-role="next"]');
        if (nextButton)
        {
            nextButton.addEventListener("click", () =>
            {
                if (this.#offset + this.#limit >= this.#totalCount)
                {
                    return;
                }
                this.#offset = this.#offset + this.#limit;
                this.#fetchPage();
            });
        }

        const selectAll = this.querySelector('[data-role="select-all"]');
        if (selectAll)
        {
            selectAll.addEventListener("change", (changeEvent) =>
            {
                const shouldSelect = changeEvent.currentTarget.checked;
                for (const row of this.#items)
                {
                    const rowId = this.#getRowId(row);
                    if (shouldSelect)
                    {
                        this.#selectedRowIds.add(rowId);
                    }
                    else
                    {
                        this.#selectedRowIds.delete(rowId);
                    }
                }
                this.#renderRows();
                this.#updateBulkBar();
            });
        }

        const bulkBar = this.querySelector('[data-role="bulk-bar"]');
        if (bulkBar)
        {
            bulkBar.addEventListener("click", (clickEvent) =>
            {
                const button = clickEvent.target.closest("[data-bulk-action]");
                if (!button)
                {
                    return;
                }
                const actionKey = button.dataset.bulkAction;
                if (typeof this.#config.onBulkAction === "function")
                {
                    this.#config.onBulkAction(actionKey, Array.from(this.#selectedRowIds));
                }
            });
        }
    }

    async #fetchPage()
    {
        // A request made while one is in flight is remembered and run once the
        // current one settles, so the final user action (last filter / page /
        // search change) is never dropped.
        if (this.#isLoading)
        {
            this.#pendingRefetch = true;
            return;
        }
        this.#isLoading = true;

        const rowsContainer = this.querySelector('[data-role="rows"]');

        try
        {
            let page;
            if (typeof this.#config.customFetcher === "function")
            {
                page = await this.#config.customFetcher
                ({
                    search: this.#searchText,
                    filters: this.#filterValues,
                    sort: this.#sort,
                    limit: this.#limit,
                    offset: this.#offset,
                    context: this.#config.requestContext || {}
                });
            }
            else
            {
                const response = await fetch("/Admin/Lists/Query",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    credentials: "include",
                    body: JSON.stringify
                    ({
                        listKey: this.#config.listKey,
                        search: this.#searchText,
                        filters: this.#filterValues,
                        sort: this.#sort,
                        limit: this.#limit,
                        offset: this.#offset,
                        context: this.#config.requestContext || {}
                    })
                });

                if (!response.ok)
                {
                    throw new Error(`Query failed with status ${response.status}`);
                }
                page = await response.json();
            }

            this.#items = Array.isArray(page.items) ? page.items : [];
            this.#totalCount = Number(page.totalCount) || 0;

            // Prune selections that are no longer on this page.
            const visibleRowIds = new Set(this.#items.map(row => this.#getRowId(row)));
            for (const selectedId of Array.from(this.#selectedRowIds))
            {
                if (!visibleRowIds.has(selectedId))
                {
                    this.#selectedRowIds.delete(selectedId);
                }
            }

            this.#renderRows();
            this.#updateFooter();
            this.#updateBulkBar();

            if (typeof this.#config.onLoaded === "function")
            {
                this.#config.onLoaded(this.#items, this.#totalCount);
            }
        }
        catch (fetchError)
        {
            console.error("[AdminListView] Failed to load page:", fetchError);
            if (rowsContainer)
            {
                const columnSpan = this.#getColumns().length + (this.#config.selectable ? 1 : 0) + (this.#hasRowActions() ? 1 : 0);
                rowsContainer.innerHTML = `<tr><td colspan="${columnSpan}" class="admin-list-error">Failed to load.</td></tr>`;
            }
        }
        finally
        {
            this.#isLoading = false;
            if (this.#pendingRefetch)
            {
                this.#pendingRefetch = false;
                this.#fetchPage();
            }
        }
    }

    #renderRows()
    {
        const rowsContainer = this.querySelector('[data-role="rows"]');
        if (!rowsContainer)
        {
            return;
        }

        const columns = this.#getColumns();

        if (this.#items.length === 0)
        {
            const columnSpan = columns.length + (this.#config.selectable ? 1 : 0) + (this.#hasRowActions() ? 1 : 0);
            rowsContainer.innerHTML = `<tr><td colspan="${columnSpan}" class="admin-list-empty">No results.</td></tr>`;
            this.#syncSelectAllCheckbox();
            return;
        }

        rowsContainer.innerHTML = this.#items.map(row =>
        {
            const rowId = this.#getRowId(row);
            const checkboxCell = this.#config.selectable
                ? `<td class="admin-list-checkbox-cell"><input type="checkbox" data-role="row-select" data-row-id="${this.#escapeHtml(rowId)}" ${this.#selectedRowIds.has(rowId) ? "checked" : ""}></td>`
                : "";

            const dataCells = columns.map(column => `<td>${this.#renderCell(row, column)}</td>`).join("");

            const actionsCell = this.#hasRowActions()
                ? `<td class="admin-list-actions">${this.#renderRowActions(row, rowId)}</td>`
                : "";

            return `<tr data-row-id="${this.#escapeHtml(rowId)}">${checkboxCell}${dataCells}${actionsCell}</tr>`;
        }).join("");

        this.#bindRowEvents();
        this.#syncSelectAllCheckbox();
    }

    #renderCell(row, column)
    {
        const value = row[column.key];

        if (column.badge && column.badge[value])
        {
            const badge = column.badge[value];
            return `<span class="admin-list-badge admin-list-badge-${this.#escapeHtml(badge.variant || "neutral")}">${this.#escapeHtml(badge.label)}</span>`;
        }

        if (column.format === "date" || column.format === "dateTime")
        {
            if (value === null || value === undefined || value === "")
            {
                return "";
            }
            const parsedDate = new Date(value);
            if (isNaN(parsedDate.getTime()))
            {
                return "";
            }
            return this.#escapeHtml(column.format === "date" ? parsedDate.toLocaleDateString() : parsedDate.toLocaleString());
        }

        if (value === null || value === undefined)
        {
            return "";
        }

        return this.#escapeHtml(String(value));
    }

    #renderRowActions(row, rowId)
    {
        const actions = this.#resolveRowActions(row);
        return actions.map(action => `<button class="admin-list-row-action" data-action="${this.#escapeHtml(action.actionKey)}" data-row-id="${this.#escapeHtml(rowId)}">${this.#escapeHtml(action.label)}</button>`).join("");
    }

    #bindRowEvents()
    {
        for (const checkbox of this.querySelectorAll('[data-role="row-select"]'))
        {
            checkbox.addEventListener("change", (changeEvent) =>
            {
                const rowId = changeEvent.currentTarget.dataset.rowId;
                if (changeEvent.currentTarget.checked)
                {
                    this.#selectedRowIds.add(rowId);
                }
                else
                {
                    this.#selectedRowIds.delete(rowId);
                }
                this.#updateBulkBar();
                this.#syncSelectAllCheckbox();
            });
        }

        for (const actionButton of this.querySelectorAll(".admin-list-row-action"))
        {
            actionButton.addEventListener("click", (clickEvent) =>
            {
                const actionKey = clickEvent.currentTarget.dataset.action;
                const rowId = clickEvent.currentTarget.dataset.rowId;
                const row = this.#items.find(candidate => this.#getRowId(candidate) === rowId) || null;
                if (typeof this.#config.onRowAction === "function")
                {
                    this.#config.onRowAction(actionKey, rowId, row);
                }
            });
        }
    }

    #updateFooter()
    {
        const countElement = this.querySelector('[data-role="count"]');
        if (countElement)
        {
            if (this.#totalCount === 0)
            {
                countElement.textContent = "0 results";
            }
            else
            {
                const firstIndex = this.#offset + 1;
                const lastIndex = Math.min(this.#offset + this.#limit, this.#totalCount);
                countElement.textContent = `${firstIndex}–${lastIndex} of ${this.#totalCount}`;
            }
        }

        const previousButton = this.querySelector('[data-role="previous"]');
        if (previousButton)
        {
            previousButton.disabled = this.#offset <= 0;
        }

        const nextButton = this.querySelector('[data-role="next"]');
        if (nextButton)
        {
            nextButton.disabled = this.#offset + this.#limit >= this.#totalCount;
        }
    }

    #updateBulkBar()
    {
        if (!this.#hasBulkActions())
        {
            return;
        }

        const selectedCount = this.#selectedRowIds.size;
        for (const button of this.querySelectorAll("[data-bulk-action]"))
        {
            const action = this.#config.bulkActions.find(candidate => candidate.actionKey === button.dataset.bulkAction);
            const baseLabel = action ? action.label : "Apply";
            button.textContent = `${baseLabel} (${selectedCount})`;
            button.disabled = selectedCount === 0;
        }
    }

    #syncSelectAllCheckbox()
    {
        const selectAll = this.querySelector('[data-role="select-all"]');
        if (!selectAll)
        {
            return;
        }

        if (this.#items.length === 0)
        {
            selectAll.checked = false;
            selectAll.indeterminate = false;
            return;
        }

        const selectedOnPage = this.#items.filter(row => this.#selectedRowIds.has(this.#getRowId(row))).length;
        selectAll.checked = selectedOnPage === this.#items.length;
        selectAll.indeterminate = selectedOnPage > 0 && selectedOnPage < this.#items.length;
    }

    refresh()
    {
        if (this.#metadata)
        {
            this.#fetchPage();
        }
    }

    getSelectedRowIds()
    {
        return Array.from(this.#selectedRowIds);
    }

    clearSelection()
    {
        this.#selectedRowIds.clear();
        this.#renderRows();
        this.#updateBulkBar();
    }

    #getColumns()
    {
        return (this.#metadata && Array.isArray(this.#metadata.columns)) ? this.#metadata.columns : [];
    }

    #getRowId(row)
    {
        const idField = (this.#config.rowIdField) || (this.#metadata && this.#metadata.rowIdField) || "id";
        return String(row[idField]);
    }

    #hasRowActions()
    {
        return this.#config.rowActions !== undefined && this.#config.rowActions !== null;
    }

    #resolveRowActions(row)
    {
        if (typeof this.#config.rowActions === "function")
        {
            return this.#config.rowActions(row) || [];
        }
        return Array.isArray(this.#config.rowActions) ? this.#config.rowActions : [];
    }

    #hasBulkActions()
    {
        return Array.isArray(this.#config.bulkActions) && this.#config.bulkActions.length > 0;
    }

    #escapeHtml(value)
    {
        return String(value === null || value === undefined ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

customElements.define("admin-list-view", AdminListView);
export default AdminListView;
