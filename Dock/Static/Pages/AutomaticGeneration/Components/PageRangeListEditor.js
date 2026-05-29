import PageRange from "../../../Globals/Classes/Decorators/PageRange.js";
import AutomaticGenerationEvents from "../../../Globals/Events/AutomaticGenerationEvents.js";


class PageRangeListEditor extends HTMLElement
{
    static tagName = "page-range-list-editor";

    static MODE_FULL_BOOK = "FULL_BOOK";
    static MODE_PAGE_RANGES = "PAGE_RANGES";

    #modeSelect = null;
    #rangesContainer = null;
    #addRangeButton = null;

    connectedCallback()
    {
        this.innerHTML =
        `
            <div class="page-range-editor-content">
                <select class="page-range-mode-select">
                    <option value="${PageRangeListEditor.MODE_FULL_BOOK}">Full Book</option>
                    <option value="${PageRangeListEditor.MODE_PAGE_RANGES}">Page Ranges</option>
                </select>
                <div class="page-range-rows-container"></div>
                <button type="button" class="page-range-add-button">+ Add Range</button>
            </div>
        `;

        this.#modeSelect = this.querySelector(".page-range-mode-select");
        this.#rangesContainer = this.querySelector(".page-range-rows-container");
        this.#addRangeButton = this.querySelector(".page-range-add-button");

        this.#modeSelect.value = PageRangeListEditor.MODE_FULL_BOOK;
        this.#syncVisibility();

        this.#modeSelect.addEventListener("change", () =>
        {
            this.#syncVisibility();
            this.#dispatchChanged();
        });

        this.#addRangeButton.addEventListener("click", () =>
        {
            this.#appendRangeRow(1, 1);
            this.#dispatchChanged();
        });
    }

    getPageRanges()
    {
        if (this.#modeSelect.value === PageRangeListEditor.MODE_FULL_BOOK)
        {
            return [];
        }

        const rangeRows = this.#rangesContainer.querySelectorAll(".page-range-row");
        const pageRanges = [];

        for (const rangeRow of rangeRows)
        {
            const startPageInput = rangeRow.querySelector(".page-range-start-input");
            const endPageInput = rangeRow.querySelector(".page-range-end-input");

            const startPage = parseInt(startPageInput.value, 10);
            const endPage = parseInt(endPageInput.value, 10);

            if (isNaN(startPage) || isNaN(endPage))
            {
                continue;
            }

            pageRanges.push(new PageRange({
                startPage: Math.max(1, startPage),
                endPage: Math.max(Math.max(1, startPage), endPage)
            }));
        }

        return pageRanges;
    }

    setPageRanges(pageRanges)
    {
        this.#rangesContainer.innerHTML = "";

        if (!Array.isArray(pageRanges) || pageRanges.length === 0)
        {
            this.#modeSelect.value = PageRangeListEditor.MODE_FULL_BOOK;
            this.#syncVisibility();
            return;
        }

        const allFullDocument = pageRanges.every(pageRange =>
        {
            return pageRange.getStartPage() === 0 && pageRange.getEndPage() === 0;
        });

        if (allFullDocument)
        {
            this.#modeSelect.value = PageRangeListEditor.MODE_FULL_BOOK;
            this.#syncVisibility();
            return;
        }

        this.#modeSelect.value = PageRangeListEditor.MODE_PAGE_RANGES;

        for (const pageRange of pageRanges)
        {
            if (pageRange.getStartPage() === 0 && pageRange.getEndPage() === 0)
            {
                continue;
            }
            this.#appendRangeRow(pageRange.getStartPage(), pageRange.getEndPage());
        }

        this.#syncVisibility();
    }

    #appendRangeRow(initialStart, initialEnd)
    {
        const rangeRow = document.createElement("div");
        rangeRow.classList.add("page-range-row");

        const startPageInput = document.createElement("input");
        startPageInput.type = "number";
        startPageInput.min = "1";
        startPageInput.value = String(initialStart);
        startPageInput.classList.add("page-range-start-input");
        startPageInput.placeholder = "Start";

        const separatorSpan = document.createElement("span");
        separatorSpan.textContent = " to ";
        separatorSpan.classList.add("page-range-separator");

        const endPageInput = document.createElement("input");
        endPageInput.type = "number";
        endPageInput.min = "1";
        endPageInput.value = String(initialEnd);
        endPageInput.classList.add("page-range-end-input");
        endPageInput.placeholder = "End";

        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.textContent = "✕";
        deleteButton.classList.add("page-range-delete-button");

        deleteButton.addEventListener("click", () =>
        {
            rangeRow.remove();
            this.#dispatchChanged();
        });

        startPageInput.addEventListener("input", () => this.#dispatchChanged());
        endPageInput.addEventListener("input", () => this.#dispatchChanged());

        rangeRow.appendChild(startPageInput);
        rangeRow.appendChild(separatorSpan);
        rangeRow.appendChild(endPageInput);
        rangeRow.appendChild(deleteButton);

        this.#rangesContainer.appendChild(rangeRow);
    }

    #syncVisibility()
    {
        const showRanges = this.#modeSelect.value === PageRangeListEditor.MODE_PAGE_RANGES;
        this.#rangesContainer.style.display = showRanges ? "" : "none";
        this.#addRangeButton.style.display = showRanges ? "" : "none";

        if (showRanges && this.#rangesContainer.children.length === 0)
        {
            this.#appendRangeRow(1, 1);
        }
    }

    #dispatchChanged()
    {
        this.dispatchEvent(new CustomEvent(AutomaticGenerationEvents.ON_SOURCES_CHANGED, {bubbles: true}));
    }
}


customElements.define("page-range-list-editor", PageRangeListEditor);
export default PageRangeListEditor;
