/**
 * PaidDeckTreePreview
 *
 * Renders a paid deck's content hierarchy from the flat treeSnapshot
 * computed at upload time. Each entry carries its own depth so we
 * indent without needing to re-parent the list — the snapshot is a
 * depth-first walk so adjacent indented rows visually nest naturally.
 *
 * Per-node counts (cards / study materials / mock tests) sit beside
 * the deck name so a buyer can see distribution at a glance without
 * needing to expand anything.
 */
class PaidDeckTreePreview extends HTMLElement
{
    #treeSnapshot = [];

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

        this.innerHTML = this.#treeSnapshot.map((node) => PaidDeckTreePreview.#renderNode(node)).join("");
    }

    static #renderNode(node)
    {
        const depth = Math.max(0, Math.min(Number(node.depth) || 0, 8));
        const cardCount = Number(node.cardCount) || 0;
        const studyMaterialCount = Number(node.studyMaterialCount) || 0;
        const mockTestCount = Number(node.mockTestCount) || 0;

        const countPieces = [];
        if (cardCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${cardCount} card${cardCount === 1 ? "" : "s"}</span>`);
        }
        if (studyMaterialCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${studyMaterialCount} material${studyMaterialCount === 1 ? "" : "s"}</span>`);
        }
        if (mockTestCount > 0)
        {
            countPieces.push(`<span class="paid-deck-tree-count">${mockTestCount} mock test${mockTestCount === 1 ? "" : "s"}</span>`);
        }

        const indentPixels = depth * 20;

        return `
            <div class="paid-deck-tree-row" style="padding-left: ${indentPixels}px;">
                <div class="paid-deck-tree-row-name">${PaidDeckTreePreview.#escape(node.name || "Untitled")}</div>
                <div class="paid-deck-tree-row-counts">${countPieces.join("") || `<span class="paid-deck-tree-count-empty">empty</span>`}</div>
            </div>
        `;
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
