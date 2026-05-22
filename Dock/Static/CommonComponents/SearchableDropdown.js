import DialogBox from "./DialogBox.js";


/**
 * Generic searchable dropdown that presents a modal picker with a
 * search box, an arrow-key-navigable list of cards, and an Enter /
 * click selection flow. Used for both static lists (e.g. parent-deck
 * selection — every deck is in memory) and async lists (e.g. the
 * generation-template picker — paginated over the network).
 *
 * Usage (static):
 *   const pickedKey = await SearchableDropdown.show({
 *       title: "Select parent deck",
 *       searchPlaceholder: "Search decks...",
 *       initialKey: currentDeckId,
 *       items: [{ key, label, sublabel }, ...]
 *   });
 *
 * Usage (async):
 *   const pickedKey = await SearchableDropdown.show({
 *       title: "Choose a template",
 *       searchPlaceholder: "Search templates...",
 *       loadItems: async (queryText, limit) => fetch(...).then(r => r.json()),
 *       resultLimit: 20
 *   });
 *
 * Each item must be either:
 *   - { key, label, sublabel? }                                      (plain shape)
 *   - { key, displayName, tagline? } (template-picker payload shape, mapped)
 *
 * Resolves to the selected `key` string, or `null` if the user closes
 * the dialog. Never throws — async loader failures surface as an empty
 * list with an error status line.
 */
class SearchableDropdown
{
    static #DEFAULT_RESULT_LIMIT      = 50;
    static #DEFAULT_SEARCH_DEBOUNCE_MS = 200;
    static #DEFAULT_EMPTY_STATE       = "No matches.";
    static #DEFAULT_LOADING_STATE     = "Loading...";
    static #DEFAULT_ERROR_STATE       = "Failed to load. Check your connection and try again.";

    /**
     * @param {object} options
     * @param {string} options.title
     * @param {string} [options.searchPlaceholder]
     * @param {Array<object>} [options.items]                                  static item list
     * @param {(queryText:string, limit:number) => Promise<Array<object>>} [options.loadItems]   async loader
     * @param {string|null} [options.initialKey]
     * @param {Array<string>} [options.initialKeys]                            multi-select preselection
     * @param {boolean} [options.multiSelect]                                  pick multiple keys and confirm with Apply
     * @param {string} [options.applyButtonLabel]
     * @param {number} [options.resultLimit]
     * @param {string} [options.emptyStateMessage]
     * @returns {Promise<string|null|Array<string>>}
     */
    static show(options)
    {
        const resultLimit         = (typeof options?.resultLimit === "number" && options.resultLimit > 0) ? options.resultLimit : SearchableDropdown.#DEFAULT_RESULT_LIMIT;
        const searchPlaceholder   = options?.searchPlaceholder || "Search...";
        const titleText           = options?.title || "Select an option";
        const initialKey          = options?.initialKey ?? null;
        const emptyStateMessage   = options?.emptyStateMessage || SearchableDropdown.#DEFAULT_EMPTY_STATE;
        const staticItemList      = Array.isArray(options?.items) ? options.items.map(item => SearchableDropdown.#normalizeItem(item)) : null;
        const asyncLoader         = (typeof options?.loadItems === "function") ? options.loadItems : null;
        const bMultiSelect        = options?.multiSelect === true;
        const applyButtonLabel    = options?.applyButtonLabel || "Apply";
        const selectedKeySet      = bMultiSelect
            ? new Set((Array.isArray(options?.initialKeys) ? options.initialKeys : []).map(rawKey => String(rawKey)))
            : new Set();

        return new Promise((resolve) =>
        {
            const actionBarMarkup = bMultiSelect
                ? `
                    <div class="searchable-dropdown-action-bar">
                        <button type="button" class="searchable-dropdown-cancel-button">Cancel</button>
                        <button type="button" class="searchable-dropdown-apply-button">${SearchableDropdown.#escapeHtml(applyButtonLabel)}</button>
                    </div>
                `
                : "";

            const dialog = DialogBox.modal(`
                <div class="searchable-dropdown-content${bMultiSelect ? " searchable-dropdown-content--multi" : ""}">
                    <h2 class="searchable-dropdown-title">${SearchableDropdown.#escapeHtml(titleText)}</h2>
                    <input type="text" class="searchable-dropdown-search-input" placeholder="${SearchableDropdown.#escapeHtml(searchPlaceholder)}" autocomplete="off">
                    <div class="searchable-dropdown-list"></div>
                    <div class="searchable-dropdown-status-line" style="display: none;"></div>
                    ${actionBarMarkup}
                </div>
            `);

            const searchInput   = dialog.querySelector(".searchable-dropdown-search-input");
            const listContainer = dialog.querySelector(".searchable-dropdown-list");
            const statusLine    = dialog.querySelector(".searchable-dropdown-status-line");

            let bResolved             = false;
            let highlightedCardIndex  = -1;
            let searchDebounceTimerId = null;
            let activeRequestSequence = 0;
            let pendingFetchAbortController = null;

            const resolveOnce = (selectionPayload) =>
            {
                if (bResolved)
                {
                    return;
                }
                bResolved = true;
                if (pendingFetchAbortController)
                {
                    pendingFetchAbortController.abort();
                }
                if (searchDebounceTimerId !== null)
                {
                    clearTimeout(searchDebounceTimerId);
                }
                dialog.close();
                resolve(selectionPayload);
            };

            const resolveWithMultiSelection = () =>
            {
                resolveOnce(Array.from(selectedKeySet));
            };

            const setStatusMessage = (message) =>
            {
                if (message === null || message === undefined || message === "")
                {
                    statusLine.style.display = "none";
                    statusLine.textContent = "";
                    return;
                }
                statusLine.style.display = "";
                statusLine.textContent = message;
            };

            const applyHighlight = () =>
            {
                const cardElements = Array.from(listContainer.querySelectorAll(".searchable-dropdown-card"));
                for (const cardElement of cardElements)
                {
                    cardElement.classList.remove("searchable-dropdown-card--highlighted");
                }
                if (highlightedCardIndex < 0 || highlightedCardIndex >= cardElements.length)
                {
                    return;
                }
                const targetCard = cardElements[highlightedCardIndex];
                targetCard.classList.add("searchable-dropdown-card--highlighted");
                targetCard.scrollIntoView({ block: "nearest" });
            };

            const renderItems = (itemList) =>
            {
                if (!Array.isArray(itemList) || itemList.length === 0)
                {
                    listContainer.innerHTML = "";
                    setStatusMessage(emptyStateMessage);
                    highlightedCardIndex = -1;
                    return;
                }

                listContainer.innerHTML = itemList
                    .map((itemEntry, itemIndex) => SearchableDropdown.#buildCardHtml(itemEntry, itemIndex, initialKey, bMultiSelect, selectedKeySet))
                    .join("");

                setStatusMessage(null);
                highlightedCardIndex = -1;
                applyHighlight();
            };

            const refreshFromStatic = (queryText) =>
            {
                const normalizedQuery = (queryText || "").trim().toLowerCase();
                if (!normalizedQuery)
                {
                    renderItems(staticItemList);
                    return;
                }

                const filteredList = staticItemList.filter(itemEntry =>
                {
                    const haystack = (itemEntry.label + " " + (itemEntry.sublabel || "")).toLowerCase();
                    return haystack.includes(normalizedQuery);
                });

                renderItems(filteredList);
            };

            const refreshFromAsync = async (queryText) =>
            {
                if (pendingFetchAbortController)
                {
                    pendingFetchAbortController.abort();
                }
                pendingFetchAbortController = new AbortController();
                const requestSequence = ++activeRequestSequence;

                setStatusMessage(SearchableDropdown.#DEFAULT_LOADING_STATE);

                try
                {
                    const loaded = await asyncLoader(queryText, resultLimit, pendingFetchAbortController.signal);

                    if (requestSequence !== activeRequestSequence)
                    {
                        return;
                    }

                    const normalizedLoadedItems = Array.isArray(loaded) ? loaded.map(item => SearchableDropdown.#normalizeItem(item)) : [];
                    renderItems(normalizedLoadedItems);
                }
                catch (loaderError)
                {
                    if (loaderError?.name === "AbortError")
                    {
                        return;
                    }
                    if (requestSequence !== activeRequestSequence)
                    {
                        return;
                    }
                    console.error(`[SearchableDropdown] Loader failed: ${loaderError?.message || loaderError}`);
                    listContainer.innerHTML = "";
                    setStatusMessage(SearchableDropdown.#DEFAULT_ERROR_STATE);
                    highlightedCardIndex = -1;
                }
            };

            const refresh = (queryText) =>
            {
                if (staticItemList !== null)
                {
                    refreshFromStatic(queryText);
                }
                else if (asyncLoader !== null)
                {
                    refreshFromAsync(queryText);
                }
                else
                {
                    listContainer.innerHTML = "";
                    setStatusMessage(emptyStateMessage);
                }
            };

            const toggleCardSelection = (cardElement) =>
            {
                const cardKey = cardElement.dataset.itemKey;
                if (selectedKeySet.has(cardKey))
                {
                    selectedKeySet.delete(cardKey);
                    cardElement.classList.remove("searchable-dropdown-card--selected");
                    const checkboxIndicator = cardElement.querySelector(".searchable-dropdown-card-checkbox");
                    if (checkboxIndicator)
                    {
                        checkboxIndicator.setAttribute("data-checked", "false");
                    }
                }
                else
                {
                    selectedKeySet.add(cardKey);
                    cardElement.classList.add("searchable-dropdown-card--selected");
                    const checkboxIndicator = cardElement.querySelector(".searchable-dropdown-card-checkbox");
                    if (checkboxIndicator)
                    {
                        checkboxIndicator.setAttribute("data-checked", "true");
                    }
                }
            };

            listContainer.addEventListener("click", (clickEvent) =>
            {
                const cardElement = clickEvent.target.closest(".searchable-dropdown-card");
                if (!cardElement)
                {
                    return;
                }
                if (bMultiSelect)
                {
                    toggleCardSelection(cardElement);
                    return;
                }
                resolveOnce(cardElement.dataset.itemKey);
            });

            if (bMultiSelect)
            {
                const applyButton  = dialog.querySelector(".searchable-dropdown-apply-button");
                const cancelButton = dialog.querySelector(".searchable-dropdown-cancel-button");
                applyButton?.addEventListener("click", () => resolveWithMultiSelection());
                cancelButton?.addEventListener("click", () => resolveOnce(null));
            }

            searchInput.addEventListener("input", () =>
            {
                if (searchDebounceTimerId !== null)
                {
                    clearTimeout(searchDebounceTimerId);
                }
                const queryText = searchInput.value;
                if (staticItemList !== null)
                {
                    refreshFromStatic(queryText);
                    return;
                }
                searchDebounceTimerId = setTimeout(() =>
                {
                    searchDebounceTimerId = null;
                    refresh(queryText.trim());
                }, SearchableDropdown.#DEFAULT_SEARCH_DEBOUNCE_MS);
            });

            searchInput.addEventListener("keydown", (keydownEvent) =>
            {
                const cardElements = Array.from(listContainer.querySelectorAll(".searchable-dropdown-card"));

                if (keydownEvent.key === "ArrowDown")
                {
                    keydownEvent.preventDefault();
                    if (cardElements.length === 0)
                    {
                        return;
                    }
                    highlightedCardIndex = Math.min(highlightedCardIndex + 1, cardElements.length - 1);
                    if (highlightedCardIndex < 0)
                    {
                        highlightedCardIndex = 0;
                    }
                    applyHighlight();
                }
                else if (keydownEvent.key === "ArrowUp")
                {
                    keydownEvent.preventDefault();
                    if (cardElements.length === 0)
                    {
                        return;
                    }
                    highlightedCardIndex = Math.max(highlightedCardIndex - 1, 0);
                    applyHighlight();
                }
                else if (keydownEvent.key === "Enter")
                {
                    keydownEvent.preventDefault();

                    // In multi-select, Enter toggles the highlighted card
                    // and keeps the dialog open — Apply / Cancel is the only
                    // way to resolve. In single-select, Enter resolves with
                    // the highlighted (or first) card.
                    if (bMultiSelect)
                    {
                        if (cardElements.length === 0)
                        {
                            resolveWithMultiSelection();
                            return;
                        }
                        const targetCard = (highlightedCardIndex >= 0) ? cardElements[highlightedCardIndex] : null;
                        if (targetCard)
                        {
                            toggleCardSelection(targetCard);
                        }
                        return;
                    }

                    if (cardElements.length === 0)
                    {
                        return;
                    }
                    const targetCard = (highlightedCardIndex >= 0) ? cardElements[highlightedCardIndex] : cardElements[0];
                    if (targetCard)
                    {
                        resolveOnce(targetCard.dataset.itemKey);
                    }
                }
                else if (keydownEvent.key === "Escape")
                {
                    keydownEvent.preventDefault();
                    resolveOnce(null);
                }
            });

            const closeButton = dialog.querySelector(".close-button");
            if (closeButton)
            {
                closeButton.addEventListener("click", () =>
                {
                    if (bResolved)
                    {
                        return;
                    }
                    bResolved = true;
                    resolve(null);
                });
            }

            refresh("");

            setTimeout(() => searchInput.focus(), 0);
        });
    }

    /**
     * Turns a static `<button>` (or any clickable element) into a
     * searchable-dropdown trigger. Clicking opens the picker; the chosen
     * key is stored on `triggerElement.dataset.selectedKey` and the
     * visible label is written into the element whose selector matches
     * `labelSelector` (defaults to the trigger itself).
     *
     * Fires a "change" CustomEvent on the trigger element with
     * `detail.selectedKey` on every selection.
     *
     * @param {HTMLElement} triggerElement
     * @param {object} options                Same shape as `show()`, plus:
     * @param {string} [options.labelSelector] CSS selector inside triggerElement for the label slot.
     * @param {string} [options.placeholderLabel] Text shown when no selection exists.
     * @param {(selectedKey: string|null) => void} [options.onSelect]
     */
    static attach(triggerElement, options)
    {
        const labelSlotElement = options?.labelSelector
            ? triggerElement.querySelector(options.labelSelector)
            : triggerElement;
        const placeholderLabel = options?.placeholderLabel || "Select...";

        const writeLabel = (labelText) =>
        {
            if (!labelSlotElement)
            {
                return;
            }
            labelSlotElement.textContent = (typeof labelText === "string" && labelText.length > 0) ? labelText : placeholderLabel;
        };

        const findLabelForKey = (resolvedKey) =>
        {
            if (resolvedKey === null || resolvedKey === undefined)
            {
                return "";
            }
            const itemList = Array.isArray(options?.items) ? options.items.map(item => SearchableDropdown.#normalizeItem(item)) : [];
            const matchingItem = itemList.find(itemEntry => itemEntry.key === resolvedKey);
            return matchingItem ? matchingItem.label : "";
        };

        if (options?.initialKey !== undefined && options?.initialKey !== null)
        {
            triggerElement.dataset.selectedKey = options.initialKey;
            writeLabel(findLabelForKey(options.initialKey));
        }
        else
        {
            writeLabel("");
        }

        triggerElement.addEventListener("click", async () =>
        {
            const currentSelectedKey = triggerElement.dataset.selectedKey || null;
            const pickedKey = await SearchableDropdown.show({
                ...options,
                initialKey: currentSelectedKey,
            });

            if (pickedKey === null || pickedKey === undefined)
            {
                return;
            }

            triggerElement.dataset.selectedKey = pickedKey;
            writeLabel(findLabelForKey(pickedKey));

            triggerElement.dispatchEvent(new CustomEvent("change", {
                detail: { selectedKey: pickedKey },
                bubbles: true,
            }));

            if (typeof options?.onSelect === "function")
            {
                options.onSelect(pickedKey);
            }
        });
    }

    static #normalizeItem(rawItem)
    {
        if (!rawItem || typeof rawItem !== "object")
        {
            return { key: "", label: "", sublabel: "" };
        }

        const key = String(rawItem.key ?? rawItem.id ?? "");
        const label = String(rawItem.label ?? rawItem.displayName ?? rawItem.name ?? key);
        const sublabel = String(rawItem.sublabel ?? rawItem.tagline ?? rawItem.description ?? "");
        return { key, label, sublabel };
    }

    static #buildCardHtml(itemEntry, itemIndex, initialSelectedKey, bMultiSelect, selectedKeySet)
    {
        const safeLabel = SearchableDropdown.#escapeHtml(itemEntry.label);
        const safeSublabel = SearchableDropdown.#escapeHtml(itemEntry.sublabel || "");
        const sublabelMarkup = safeSublabel.length > 0
            ? `<div class="searchable-dropdown-card-sublabel">${safeSublabel}</div>`
            : "";

        const isCurrentSelection = (!bMultiSelect && initialSelectedKey !== null && initialSelectedKey !== undefined && itemEntry.key === String(initialSelectedKey));
        const isMultiSelected = bMultiSelect && selectedKeySet && selectedKeySet.has(itemEntry.key);
        const selectionMarker = isCurrentSelection ? `<span class="searchable-dropdown-card-current-marker">Current</span>` : "";
        const checkboxMarker = bMultiSelect
            ? `<span class="searchable-dropdown-card-checkbox" data-checked="${isMultiSelected ? "true" : "false"}" aria-hidden="true"></span>`
            : "";

        const classList = ["searchable-dropdown-card"];
        if (isCurrentSelection)
        {
            classList.push("searchable-dropdown-card--current");
        }
        if (isMultiSelected)
        {
            classList.push("searchable-dropdown-card--selected");
        }

        return `
            <button type="button" class="${classList.join(" ")}" data-item-key="${SearchableDropdown.#escapeHtml(itemEntry.key)}" data-card-index="${itemIndex}">
                ${checkboxMarker}
                <div class="searchable-dropdown-card-body">
                    <div class="searchable-dropdown-card-title-row">
                        <span class="searchable-dropdown-card-title">${safeLabel}</span>
                        ${selectionMarker}
                    </div>
                    ${sublabelMarkup}
                </div>
            </button>
        `;
    }

    static #escapeHtml(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default SearchableDropdown;
