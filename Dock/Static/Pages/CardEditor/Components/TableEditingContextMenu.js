import ContextMenu from "../../../CommonComponents/ContextMenu.js";

/**
 * TableEditingContextMenu
 *
 * Right-click context menu surfaced by RichTextEditor when the user
 * right-clicks inside a <table> within the editable area. Offers the
 * row / column / table operations that browsers don't expose natively
 * (document.execCommand has no table commands).
 *
 * Each action is resolved against the originating <td> / <th> cell
 * (captured at create time) so the operation knows which row / column
 * to act on. The host editor stays out of these mechanics — it just
 * decides when to open the menu.
 */
class TableEditingContextMenu extends ContextMenu
{
    static tagName = "table-editing-context-menu";

    #targetCell = null;

    /**
     * Override of ContextMenu.create so the caller can pass the cell
     * that was right-clicked alongside the screen position.
     */
    static create(position = { x: 0, y: 0 }, targetCell = null)
    {
        return super.create(position, targetCell);
    }

    initialize(position = { x: 0, y: 0 }, targetCell = null)
    {
        super.initialize(position);
        this.#targetCell = targetCell;
    }

    #getOwningRow()
    {
        return this.#targetCell ? this.#targetCell.parentElement : null;
    }

    #getOwningTable()
    {
        return this.#targetCell ? this.#targetCell.closest("table") : null;
    }

    #getColumnIndex()
    {
        const row = this.#getOwningRow();
        if (!row || !this.#targetCell)
        {
            return -1;
        }
        return Array.prototype.indexOf.call(row.children, this.#targetCell);
    }

    /**
     * Insert a fresh <tr> populated with the same column count as the
     * table's widest row. The new cells default to a non-breaking space
     * so the row is visible and clickable straight away.
     */
    #insertRow(bAbove)
    {
        const table = this.#getOwningTable();
        const referenceRow = this.#getOwningRow();
        if (!table || !referenceRow)
        {
            return;
        }

        const columnCount = TableEditingContextMenu.#getColumnCount(table);
        const newRow = document.createElement("tr");
        for (let columnIndex = 0; columnIndex < columnCount; columnIndex++)
        {
            const newCell = document.createElement("td");
            newCell.innerHTML = "&nbsp;";
            newRow.appendChild(newCell);
        }

        if (bAbove)
        {
            referenceRow.parentElement.insertBefore(newRow, referenceRow);
        }
        else
        {
            referenceRow.parentElement.insertBefore(newRow, referenceRow.nextSibling);
        }
    }

    /**
     * Insert a new cell into every existing row at the supplied offset
     * from the target cell's column. `bRight=true` puts the new column
     * AFTER the target column, otherwise before it. Header rows get a
     * <th>, body rows get a <td>, so a table with a head row stays
     * structurally consistent.
     */
    #insertColumn(bRight)
    {
        const table = this.#getOwningTable();
        const targetColumnIndex = this.#getColumnIndex();
        if (!table || targetColumnIndex < 0)
        {
            return;
        }

        const insertionIndex = bRight ? targetColumnIndex + 1 : targetColumnIndex;
        const allRows = table.querySelectorAll("tr");
        for (const row of allRows)
        {
            const referenceCell = row.children[insertionIndex] || null;
            const cellTag = (row.querySelector("th") && !row.querySelector("td")) ? "th" : "td";
            const newCell = document.createElement(cellTag);
            newCell.innerHTML = "&nbsp;";
            row.insertBefore(newCell, referenceCell);
        }
    }

    #deleteRow()
    {
        const row = this.#getOwningRow();
        const table = this.#getOwningTable();
        if (!row || !table)
        {
            return;
        }

        // Refuse to leave a header-only / empty table behind — if this
        // is the last row, drop the whole table so the user doesn't end
        // up with an invisible empty <table> they can't click into.
        if (table.querySelectorAll("tr").length <= 1)
        {
            table.remove();
            return;
        }
        row.remove();
    }

    #deleteColumn()
    {
        const table = this.#getOwningTable();
        const columnIndex = this.#getColumnIndex();
        if (!table || columnIndex < 0)
        {
            return;
        }

        // Refuse to leave a zero-column table behind — same reasoning
        // as deleteRow: drop the table outright when this is the last
        // column.
        if (TableEditingContextMenu.#getColumnCount(table) <= 1)
        {
            table.remove();
            return;
        }

        const allRows = table.querySelectorAll("tr");
        for (const row of allRows)
        {
            const cellToRemove = row.children[columnIndex];
            if (cellToRemove)
            {
                cellToRemove.remove();
            }
        }
    }

    #deleteTable()
    {
        const table = this.#getOwningTable();
        table?.remove();
    }

    /**
     * Inspect every <tr> in the table and return the widest column
     * count. Using max-of-rows lets us survive partially-rendered
     * tables (e.g. a half-finished paste) without dropping into a row
     * with the wrong number of cells.
     */
    static #getColumnCount(table)
    {
        let columnCount = 0;
        const rows = table.querySelectorAll("tr");
        for (const row of rows)
        {
            if (row.children.length > columnCount)
            {
                columnCount = row.children.length;
            }
        }
        return columnCount;
    }

    #handleEvents()
    {
        this.querySelector(".add-row-above-button")?.addEventListener("click", () => this.#insertRow(true));
        this.querySelector(".add-row-below-button")?.addEventListener("click", () => this.#insertRow(false));
        this.querySelector(".add-column-left-button")?.addEventListener("click", () => this.#insertColumn(false));
        this.querySelector(".add-column-right-button")?.addEventListener("click", () => this.#insertColumn(true));
        this.querySelector(".delete-row-button")?.addEventListener("click", () => this.#deleteRow());
        this.querySelector(".delete-column-button")?.addEventListener("click", () => this.#deleteColumn());
        this.querySelector(".delete-table-button")?.addEventListener("click", () => this.#deleteTable());
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="add-row-above-button"    type="button">Add row above</button>
            <button class="add-row-below-button"    type="button">Add row below</button>
            <button class="add-column-left-button"  type="button">Add column left</button>
            <button class="add-column-right-button" type="button">Add column right</button>
            <button class="delete-row-button"       type="button">Delete row</button>
            <button class="delete-column-button"    type="button">Delete column</button>
            <button class="delete-table-button"     type="button">Delete table</button>
        `;

        super.connectedCallback();
        this.#handleEvents();
    }
}

customElements.define(TableEditingContextMenu.tagName, TableEditingContextMenu);
export default TableEditingContextMenu;
