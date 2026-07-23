import DialogBox from "./DialogBox.js";
import Deck from "../Globals/Model/Deck.js";
import DeckEvents from "../Globals/Events/DeckEvents.js";
import InformationSource from "../Globals/Model/InformationSource.js";
import DeckStorageCalculator from "../Globals/Classes/DeckStorageCalculator.js";
import { formatBytes } from "../Globals/UtilityFunctions/FormatBytes.js";

/**
 * StorageManagerDialog
 *
 * A "Manage storage" modal opened from the Settings storage section. Two tabs:
 *   • Decks — an expandable tree of the user's deck hierarchy, each node showing
 *     its subtree byte size, with a per-node Delete that behaves IDENTICALLY to
 *     deleting a deck from the deck-tile edit menu (it calls Deck.delete(), which
 *     cascades children/cards/materials/mock-tests, tombstones them for sync,
 *     updates the in-memory tree and re-saves the parent). Paid decks are shown
 *     for their size but not deletable here — their removal is a server-first
 *     license flow, so this dialog defers to the home-screen "Delete copy".
 *   • Uploads — a flat list of uploaded sources, each showing its file size, with
 *     a per-item Delete that calls the /InformationSource/Delete endpoint.
 *
 * Built on the house dialog pattern: a static show() that hosts injected HTML in
 * DialogBox.modal, tabs switched by display-toggle (state survives switching),
 * and DialogBox.confirm before every destructive action.
 *
 * `onChanged` is invoked after any successful deletion so the caller (Settings)
 * can refresh the storage meter — the deck side is eventual (it lands via the
 * debounced sync), the upload side is immediate server-side.
 */
class StorageManagerDialog
{
    static #TAB_DECKS = "decks";
    static #TAB_UPLOADS = "uploads";

    /**
     * Opens the dialog.
     * @param {() => void} [onChanged] Called after any successful deletion.
     */
    static show(onChanged = null)
    {
        const dialog = DialogBox.modal(
        `
            <div class="storage-manager">
                <div class="storage-manager-title">Manage storage</div>
                <div class="storage-manager-tabs">
                    <button class="storage-manager-tab storage-manager-tab-active" type="button" data-tab="${StorageManagerDialog.#TAB_DECKS}">Decks</button>
                    <button class="storage-manager-tab" type="button" data-tab="${StorageManagerDialog.#TAB_UPLOADS}">Uploads</button>
                </div>
                <div class="storage-manager-panel" data-panel="${StorageManagerDialog.#TAB_DECKS}"></div>
                <div class="storage-manager-panel" data-panel="${StorageManagerDialog.#TAB_UPLOADS}" hidden></div>
            </div>
        `);

        StorageManagerDialog.#wireTabs(dialog);
        StorageManagerDialog.#renderDecks(dialog, onChanged);
        StorageManagerDialog.#renderUploads(dialog, onChanged);

        return dialog;
    }

    static #wireTabs(dialog)
    {
        for (const tabButton of dialog.querySelectorAll(".storage-manager-tab"))
        {
            tabButton.addEventListener("click", () =>
            {
                const selectedTab = tabButton.dataset.tab;

                for (const button of dialog.querySelectorAll(".storage-manager-tab"))
                {
                    button.classList.toggle("storage-manager-tab-active", button.dataset.tab === selectedTab);
                }

                for (const panel of dialog.querySelectorAll(".storage-manager-panel"))
                {
                    panel.hidden = panel.dataset.panel !== selectedTab;
                }
            });
        }
    }

    // ── Decks tab ──────────────────────────────────────────────────────────

    static #renderDecks(dialog, onChanged)
    {
        const panel = dialog.querySelector(`.storage-manager-panel[data-panel="${StorageManagerDialog.#TAB_DECKS}"]`);
        if (!panel)
        {
            return;
        }

        const rootDeck = Deck.getRoot();
        const topLevelDecks = rootDeck ? rootDeck.getSubDecks() : [];

        if (topLevelDecks.length === 0)
        {
            panel.innerHTML = `<div class="storage-manager-empty">No decks yet.</div>`;
            return;
        }

        const treeHtml = topLevelDecks.map(deck => StorageManagerDialog.#buildDeckNodeHtml(deck, 0)).join("");
        panel.innerHTML = `<div class="storage-manager-tree" data-role="tree">${treeHtml}</div>`;

        StorageManagerDialog.#wireTree(dialog, panel, onChanged);
    }

    // Recursively builds one deck node: a row (caret + name + subtree size +
    // delete/paid control) plus a collapsed children container that holds the
    // same markup for each subdeck. Depth drives the indent.
    static #buildDeckNodeHtml(deck, depth)
    {
        const subDecks = deck.getSubDecks();
        const hasChildren = subDecks.length > 0;
        const subtreeBytes = DeckStorageCalculator.getSubtreeBytes(deck);
        const isPaidDeck = Boolean(deck.getAdditionalData()?.paidDeckId);

        const caretHtml = hasChildren
            ? `<span class="storage-manager-tree-caret" data-role="caret">&#x25B8;</span>`
            : `<span class="storage-manager-tree-caret storage-manager-tree-caret-empty"></span>`;

        const actionHtml = isPaidDeck
            ? `<span class="storage-manager-tree-paid" title="Purchased decks are removed from the home screen with &quot;Delete copy&quot;.">Paid</span>`
            : `<button class="storage-manager-tree-delete" type="button" data-deck-id="${deck.getId()}">Delete</button>`;

        const childrenHtml = hasChildren
            ? `<div class="storage-manager-tree-children" data-role="children" hidden>${subDecks.map(subDeck => StorageManagerDialog.#buildDeckNodeHtml(subDeck, depth + 1)).join("")}</div>`
            : "";

        // The deck name is user-authored — escape it so a deck titled with markup
        // can't inject into the dialog.
        const safeName = StorageManagerDialog.#escapeHtml(deck.getName() ?? "Untitled deck");

        return `
            <div class="storage-manager-tree-node" data-deck-id="${deck.getId()}">
                <div class="storage-manager-tree-row" style="padding-left: ${depth * 18}px;">
                    ${caretHtml}
                    <span class="storage-manager-tree-name" title="${safeName}">${safeName}</span>
                    <span class="storage-manager-tree-size">${formatBytes(subtreeBytes)}</span>
                    ${actionHtml}
                </div>
                ${childrenHtml}
            </div>
        `;
    }

    static #wireTree(dialog, panel, onChanged)
    {
        const tree = panel.querySelector('[data-role="tree"]');
        if (!tree)
        {
            return;
        }

        tree.addEventListener("click", (clickEvent) =>
        {
            const caret = clickEvent.target.closest(".storage-manager-tree-caret");
            if (caret && !caret.classList.contains("storage-manager-tree-caret-empty"))
            {
                const node = caret.closest(".storage-manager-tree-node");
                const children = node ? node.querySelector(':scope > [data-role="children"]') : null;
                if (children)
                {
                    const willExpand = children.hidden;
                    children.hidden = !willExpand;
                    caret.innerHTML = willExpand ? "&#x25BE;" : "&#x25B8;";
                }
                return;
            }

            const deleteButton = clickEvent.target.closest(".storage-manager-tree-delete");
            if (deleteButton)
            {
                StorageManagerDialog.#handleDeckDelete(dialog, deleteButton.dataset.deckId, onChanged);
            }
        });
    }

    static async #handleDeckDelete(dialog, deckId, onChanged)
    {
        const deck = Deck.getById(deckId);
        if (!deck)
        {
            return;
        }

        // Paid decks are never given a Delete control here, but re-check the
        // stored flag so a paid deck can never be torn down through this path
        // (which would skip the server-side license cleanup).
        if (deck.getAdditionalData()?.paidDeckId)
        {
            return;
        }

        const deckName = deck.getName() ?? "this deck";
        const confirmed = await DialogBox.confirm(
            "Delete deck",
            `Delete "${deckName}" and everything inside it — its subdecks, cards, study materials and mock tests? This cannot be undone.`
        );

        if (!confirmed)
        {
            return;
        }

        const parentDeck = deck.getParent();

        try
        {
            await deck.delete();
        }
        catch (deleteError)
        {
            console.error("[StorageManagerDialog] Deck delete failed:", deleteError);
            await DialogBox.alert("Delete failed", "The deck could not be deleted. Please try again.");
            return;
        }

        // Same refresh signal the deck-editor delete fires, so any mounted
        // HomePage re-renders the parent level.
        window.dispatchEvent(new CustomEvent(DeckEvents.DELETE, { detail: { parent: parentDeck } }));

        StorageManagerDialog.#renderDecks(dialog, onChanged);

        if (typeof onChanged === "function")
        {
            onChanged();
        }
    }

    // ── Uploads tab ────────────────────────────────────────────────────────

    static async #renderUploads(dialog, onChanged)
    {
        const panel = dialog.querySelector(`.storage-manager-panel[data-panel="${StorageManagerDialog.#TAB_UPLOADS}"]`);
        if (!panel)
        {
            return;
        }

        panel.innerHTML = `<div class="storage-manager-empty">Loading uploads…</div>`;

        let informationSources = [];
        try
        {
            const response = await fetch("/InformationSource/List", { credentials: "include" });
            if (!response.ok)
            {
                panel.innerHTML = `<div class="storage-manager-empty">Couldn't load your uploads right now.</div>`;
                return;
            }
            const sourcesJson = await response.json();
            informationSources = sourcesJson.map(sourceJson => InformationSource.fromJson(sourceJson));
        }
        catch (loadError)
        {
            console.error("[StorageManagerDialog] Uploads load failed:", loadError);
            panel.innerHTML = `<div class="storage-manager-empty">Couldn't reach the server.</div>`;
            return;
        }

        if (informationSources.length === 0)
        {
            panel.innerHTML = `<div class="storage-manager-empty">No uploads yet.</div>`;
            return;
        }

        const rowsHtml = informationSources.map(informationSource =>
        {
            const safeName = StorageManagerDialog.#escapeHtml(informationSource.getName() ?? "Unnamed source");
            const fileSizeBytes = informationSource.getFileSizeBytes() ?? 0;
            return `
                <div class="storage-manager-upload-row" data-source-id="${informationSource.getId()}">
                    <span class="storage-manager-upload-name" title="${safeName}">${safeName}</span>
                    <span class="storage-manager-upload-size">${formatBytes(fileSizeBytes)}</span>
                    <button class="storage-manager-upload-delete" type="button" data-source-id="${informationSource.getId()}">Delete</button>
                </div>
            `;
        }).join("");

        panel.innerHTML = `<div class="storage-manager-upload-list" data-role="uploads">${rowsHtml}</div>`;

        const sourcesById = new Map(informationSources.map(source => [source.getId(), source]));
        const list = panel.querySelector('[data-role="uploads"]');
        list.addEventListener("click", (clickEvent) =>
        {
            const deleteButton = clickEvent.target.closest(".storage-manager-upload-delete");
            if (deleteButton)
            {
                StorageManagerDialog.#handleUploadDelete(dialog, sourcesById.get(deleteButton.dataset.sourceId), onChanged);
            }
        });
    }

    static async #handleUploadDelete(dialog, informationSource, onChanged)
    {
        if (!informationSource)
        {
            return;
        }

        const sourceName = informationSource.getName() ?? "this source";
        const confirmed = await DialogBox.confirm(
            "Delete upload",
            `Delete "${sourceName}"? This permanently removes the uploaded file and frees its storage. This cannot be undone.`
        );

        if (!confirmed)
        {
            return;
        }

        try
        {
            const response = await fetch("/InformationSource/Delete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ informationSourceId: informationSource.getId() })
            });

            if (!response.ok)
            {
                await DialogBox.alert("Delete failed", "The upload could not be deleted. Please try again later.");
                return;
            }
        }
        catch (deleteError)
        {
            console.error("[StorageManagerDialog] Upload delete failed:", deleteError);
            await DialogBox.alert("Delete failed", "Could not reach the server. Please try again later.");
            return;
        }

        await StorageManagerDialog.#renderUploads(dialog, onChanged);

        if (typeof onChanged === "function")
        {
            onChanged();
        }
    }

    static #escapeHtml(value)
    {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default StorageManagerDialog;
