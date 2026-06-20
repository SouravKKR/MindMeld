/**
 * PaidDeckTreePreview
 *
 * Renders a paid deck's content hierarchy from the flat treeSnapshot
 * computed at upload time as a proper collapsible tree. The snapshot is
 * a depth-first walk where each entry carries its own depth, so the tree
 * is reconstructed with a depth stack before rendering.
 *
 * Every deck node that has sub-decks gets a caret and a clickable row to
 * expand / collapse its own subtree independently. By default the top
 * level (depth 0) is open so its first subdecks show, while those
 * subdecks start collapsed behind their own carets; an "Expand all" /
 * "Collapse all" control flips every node at once.
 *
 * Per-node counts (cards / study materials / mock tests) sit beside the
 * deck name so a buyer can see distribution at a glance.
 */
class PaidDeckTreePreview extends HTMLElement
{
    // A node is expanded by default when its depth is below this — depth 0
    // (the bundle root) starts open so its first subdecks are visible;
    // deeper nodes start collapsed behind their own carets.
    static #INITIAL_VISIBLE_DEPTH = 1;
    static #MAXIMUM_DEPTH = 8;

    #treeSnapshot = [];
    #boundHandleClick = null;

    initialize(treeSnapshot)
    {
        this.#treeSnapshot = Array.isArray(treeSnapshot) ? treeSnapshot : [];
    }

    connectedCallback()
    {
        if (this.#treeSnapshot.length === 0)
        {
            this.innerHTML = `<div class="paid-deck-tree-preview-empty">No content preview available for this deck.</div>`;
            return;
        }

        const rootNodes = PaidDeckTreePreview.#buildNestedTree(this.#treeSnapshot);

        // The "Expand all" control is only useful when something starts
        // collapsed — i.e. when there is content deeper than the first level.
        const hasCollapsibleDepth = this.#treeSnapshot.some((snapshotEntry) =>
        {
            return (Number(snapshotEntry.depth) || 0) > PaidDeckTreePreview.#INITIAL_VISIBLE_DEPTH;
        });

        const rowsMarkup = rootNodes.map((rootNode) => PaidDeckTreePreview.#renderNode(rootNode)).join("");

        this.innerHTML = `
            ${hasCollapsibleDepth ? `
                <div class="paid-deck-tree-toolbar">
                    <button type="button" class="paid-deck-tree-toggle-all" data-role="toggle-all" data-all-expanded="false">Expand all</button>
                </div>
            ` : ""}
            <div class="paid-deck-tree-rows" data-role="tree-rows">${rowsMarkup}</div>
        `;

        this.#wireInteractions();
    }

    #wireInteractions()
    {
        // connectedCallback can run more than once (the details page calls it
        // again after initialize), so detach the previous delegated listener
        // before attaching a fresh one to avoid stacking duplicates.
        if (this.#boundHandleClick !== null)
        {
            this.removeEventListener("click", this.#boundHandleClick);
        }
        this.#boundHandleClick = (clickEvent) => this.#handleClick(clickEvent);
        this.addEventListener("click", this.#boundHandleClick);
    }

    #handleClick(clickEvent)
    {
        const toggleAllButton = clickEvent.target.closest('[data-role="toggle-all"]');
        if (toggleAllButton !== null && this.contains(toggleAllButton))
        {
            this.#toggleAll(toggleAllButton);
            return;
        }

        // The whole row is the hit target (the caret is just the affordance),
        // so a node only toggles when it actually has sub-decks to reveal.
        const rowElement = clickEvent.target.closest(".paid-deck-tree-row");
        if (rowElement === null || !this.contains(rowElement))
        {
            return;
        }

        const nodeElement = rowElement.closest(".paid-deck-tree-node");
        if (nodeElement === null || nodeElement.getAttribute("data-has-children") !== "true")
        {
            return;
        }

        const isExpanded = nodeElement.getAttribute("data-expanded") === "true";
        nodeElement.setAttribute("data-expanded", isExpanded ? "false" : "true");
    }

    #toggleAll(toggleAllButton)
    {
        const shouldExpandAll = toggleAllButton.getAttribute("data-all-expanded") !== "true";

        for (const nodeElement of this.querySelectorAll(".paid-deck-tree-node"))
        {
            if (shouldExpandAll)
            {
                nodeElement.setAttribute("data-expanded", "true");
            }
            else
            {
                // Collapse back to the default view rather than hiding
                // everything — the top level stays open.
                const depth = Number(nodeElement.getAttribute("data-depth")) || 0;
                const expandedByDefault = depth < PaidDeckTreePreview.#INITIAL_VISIBLE_DEPTH;
                nodeElement.setAttribute("data-expanded", expandedByDefault ? "true" : "false");
            }
        }

        toggleAllButton.setAttribute("data-all-expanded", shouldExpandAll ? "true" : "false");
        toggleAllButton.textContent = shouldExpandAll ? "Collapse all" : "Expand all";
    }

    /**
     * Reconstructs the nested tree from the flat depth-first snapshot using
     * a depth stack: each node's parent is the most recent node shallower
     * than it. Nodes with no shallower ancestor are roots.
     */
    static #buildNestedTree(treeSnapshot)
    {
        const rootNodes = [];
        const ancestorStack = [];

        for (const snapshotEntry of treeSnapshot)
        {
            const depth = Math.max(0, Math.min(Number(snapshotEntry.depth) || 0, PaidDeckTreePreview.#MAXIMUM_DEPTH));
            const node =
            {
                name: snapshotEntry.name,
                depth: depth,
                cardCount: Number(snapshotEntry.cardCount) || 0,
                studyMaterialCount: Number(snapshotEntry.studyMaterialCount) || 0,
                mockTestCount: Number(snapshotEntry.mockTestCount) || 0,
                children: []
            };

            while (ancestorStack.length > 0 && ancestorStack[ancestorStack.length - 1].depth >= depth)
            {
                ancestorStack.pop();
            }

            if (ancestorStack.length === 0)
            {
                rootNodes.push(node);
            }
            else
            {
                ancestorStack[ancestorStack.length - 1].children.push(node);
            }

            ancestorStack.push(node);
        }

        return rootNodes;
    }

    static #renderNode(node)
    {
        const hasChildren = node.children.length > 0;
        const isExpandedByDefault = node.depth < PaidDeckTreePreview.#INITIAL_VISIBLE_DEPTH;

        const caretMarkup = hasChildren
            ? `<span class="paid-deck-tree-caret" aria-hidden="true">&#9656;</span>`
            : `<span class="paid-deck-tree-caret-spacer"></span>`;

        const childrenMarkup = hasChildren
            ? `<div class="paid-deck-tree-children">${node.children.map((childNode) => PaidDeckTreePreview.#renderNode(childNode)).join("")}</div>`
            : "";

        return `
            <div class="paid-deck-tree-node" data-depth="${node.depth}" data-has-children="${hasChildren ? "true" : "false"}" data-expanded="${isExpandedByDefault ? "true" : "false"}">
                <div class="paid-deck-tree-row">
                    ${caretMarkup}
                    <div class="paid-deck-tree-row-name">${PaidDeckTreePreview.#escape(node.name || "Untitled")}</div>
                    <div class="paid-deck-tree-row-counts">${PaidDeckTreePreview.#renderCounts(node)}</div>
                </div>
                ${childrenMarkup}
            </div>
        `;
    }

    static #renderCounts(node)
    {
        const countPieces = [];
        if (node.cardCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${node.cardCount} card${node.cardCount === 1 ? "" : "s"}</span>`);
        }
        if (node.studyMaterialCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${node.studyMaterialCount} material${node.studyMaterialCount === 1 ? "" : "s"}</span>`);
        }
        if (node.mockTestCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${node.mockTestCount} mock test${node.mockTestCount === 1 ? "" : "s"}</span>`);
        }
        return countPieces.join("") || `<span class="paid-deck-tree-count-empty">empty</span>`;
    }

    static #escape(rawValue)
    {
        return String(rawValue ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

customElements.define("paid-deck-tree-preview", PaidDeckTreePreview);
export default PaidDeckTreePreview;
