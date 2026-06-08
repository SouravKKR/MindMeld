import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckContentClient from "../../Globals/Classes/PaidDeckContentClient.js";
import PaidDeckSession from "../../Globals/Classes/Crypto/PaidDeckSession.js";
import { entityTypes } from "../../Globals/Enumerations/EntityTypes.js";

/**
 * PaidDeckBrowsePage
 *
 * Buyer-facing browse + lightweight edit surface for a paid deck. The
 * manifest tree (deck hierarchy + card / study material / mock test
 * leaves) loads via /PaidDecks/Manifest under ECDH + content-key
 * encryption; clicking a leaf lazily fetches just that entity through
 * PaidDeckContentClient.getEntity (which batches and caches encrypted
 * blobs in IDB). Saves are routed back through
 * PaidDeckContentClient.updateEntity — never through IndexedDB sync.
 *
 * This is the buyer-side entry point; the full SpacedRepetitionSession
 * integration is intentionally deferred (the existing session expects
 * a fully loaded in-memory Deck object — beyond this round's scope).
 */
class PaidDeckBrowsePage extends HTMLElement
{
    #deckId = "";
    #deckTitle = "";
    #manifestEntriesByEntityId = new Map();
    #childrenByParentId = new Map();
    #rootDeckId = "";
    #selectedEntityId = "";

    initialize(paidDeck)
    {
        this.#deckId = paidDeck?.id || "";
        this.#deckTitle = paidDeck?.title || "Paid deck";
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");
        this.innerHTML = `
            <header-component title="${PaidDeckBrowsePage.#escape(this.#deckTitle)}"></header-component>
            <div class="paid-deck-browse-body">
                <aside class="paid-deck-browse-tree" data-role="tree">
                    <div class="paid-deck-browse-loading">Unlocking…</div>
                </aside>
                <main class="paid-deck-browse-detail" data-role="detail">
                    <div class="paid-deck-browse-placeholder">Select an item to view its content.</div>
                </main>
            </div>
        `;

        const openResult = await PaidDeckContentClient.openDeck(this.#deckId);
        if (!openResult.success)
        {
            this.querySelector('[data-role="tree"]').innerHTML = `<div class="paid-deck-browse-error">Couldn't unlock deck — ${PaidDeckBrowsePage.#escape(openResult.reason || "unknown")}.</div>`;
            return;
        }

        this.#ingestManifest(openResult.manifest);
        this.#renderTree();
    }

    #ingestManifest(manifest)
    {
        this.#manifestEntriesByEntityId.clear();
        this.#childrenByParentId.clear();
        this.#rootDeckId = manifest?.rootDeckId || "";

        const manifestEntries = Array.isArray(manifest?.entries) ? manifest.entries : [];
        for (const manifestEntry of manifestEntries)
        {
            this.#manifestEntriesByEntityId.set(manifestEntry.entityId, manifestEntry);
            const parentKey = manifestEntry.parentId || "__ROOT__";
            if (!this.#childrenByParentId.has(parentKey))
            {
                this.#childrenByParentId.set(parentKey, []);
            }
            this.#childrenByParentId.get(parentKey).push(manifestEntry);
        }
    }

    #renderTree()
    {
        const treeContainer = this.querySelector('[data-role="tree"]');
        const treeMarkup = this.#renderSubtree(this.#rootDeckId, 0);
        treeContainer.innerHTML = treeMarkup || `<div class="paid-deck-browse-empty">No content in this deck.</div>`;

        for (const treeRow of treeContainer.querySelectorAll(".paid-deck-browse-row"))
        {
            treeRow.addEventListener("click", (clickEvent) =>
            {
                const targetEntityId = clickEvent.currentTarget.dataset.entityId;
                this.#openEntity(targetEntityId);
            });
        }
    }

    #renderSubtree(parentEntityId, depth)
    {
        if (!parentEntityId)
        {
            return "";
        }
        const rootEntry = this.#manifestEntriesByEntityId.get(parentEntityId);
        if (!rootEntry)
        {
            return "";
        }

        const rootRow = this.#renderRow(rootEntry, depth);

        const childEntries = this.#childrenByParentId.get(parentEntityId) || [];
        const childRows = childEntries
            .filter((childEntry) => childEntry.entityId !== parentEntityId)
            .map((childEntry) =>
            {
                if (childEntry.type === entityTypes.DECK)
                {
                    return this.#renderSubtree(childEntry.entityId, depth + 1);
                }
                return this.#renderRow(childEntry, depth + 1);
            })
            .join("");

        return rootRow + childRows;
    }

    #renderRow(entry, depth)
    {
        const indentPixels = Math.max(0, Math.min(depth, 6)) * 16;
        const typeLabel = PaidDeckBrowsePage.#labelForEntityType(entry.type);
        const isSelected = entry.entityId === this.#selectedEntityId;
        return `
            <div class="paid-deck-browse-row ${isSelected ? "paid-deck-browse-row-selected" : ""}" data-entity-id="${PaidDeckBrowsePage.#escape(entry.entityId)}" style="padding-left: ${indentPixels}px;">
                <span class="paid-deck-browse-row-type">${typeLabel}</span>
                <span class="paid-deck-browse-row-name">${PaidDeckBrowsePage.#escape(entry.name || "Untitled")}</span>
            </div>
        `;
    }

    async #openEntity(entityId)
    {
        this.#selectedEntityId = entityId;
        this.#renderTree();

        const detailContainer = this.querySelector('[data-role="detail"]');
        detailContainer.innerHTML = `<div class="paid-deck-browse-loading">Loading…</div>`;

        const entryMetadata = this.#manifestEntriesByEntityId.get(entityId);
        if (!entryMetadata)
        {
            detailContainer.innerHTML = `<div class="paid-deck-browse-error">Entity not found in manifest.</div>`;
            return;
        }

        try
        {
            const plaintextEntity = await PaidDeckContentClient.getEntity(this.#deckId, entityId);
            this.#renderEntityDetail(entryMetadata, plaintextEntity);
        }
        catch (fetchError)
        {
            detailContainer.innerHTML = `<div class="paid-deck-browse-error">Failed to load: ${PaidDeckBrowsePage.#escape(fetchError.message)}</div>`;
        }

        const nextLeafEntityIds = this.#peekUpcomingLeafEntities(entityId, 3);
        if (nextLeafEntityIds.length > 0)
        {
            PaidDeckContentClient.prefetchEntities(this.#deckId, nextLeafEntityIds).catch(() => {});
        }
    }

    #peekUpcomingLeafEntities(currentEntityId, lookAhead)
    {
        const allLeafEntries = [];
        for (const manifestEntry of this.#manifestEntriesByEntityId.values())
        {
            if (manifestEntry.type !== entityTypes.DECK)
            {
                allLeafEntries.push(manifestEntry);
            }
        }
        const currentIndex = allLeafEntries.findIndex((leafEntry) => leafEntry.entityId === currentEntityId);
        if (currentIndex < 0)
        {
            return [];
        }
        return allLeafEntries.slice(currentIndex + 1, currentIndex + 1 + lookAhead).map((leafEntry) => leafEntry.entityId);
    }

    #renderEntityDetail(entryMetadata, plaintextEntity)
    {
        const detailContainer = this.querySelector('[data-role="detail"]');
        if (!plaintextEntity)
        {
            detailContainer.innerHTML = `<div class="paid-deck-browse-error">Entity returned no content.</div>`;
            return;
        }

        const typeLabel = PaidDeckBrowsePage.#labelForEntityType(entryMetadata.type);
        const editableJsonString = JSON.stringify(plaintextEntity, null, 2);

        detailContainer.innerHTML = `
            <div class="paid-deck-browse-detail-header">
                <span class="paid-deck-browse-detail-type">${typeLabel}</span>
                <span class="paid-deck-browse-detail-name">${PaidDeckBrowsePage.#escape(entryMetadata.name || "Untitled")}</span>
            </div>
            <p class="paid-deck-browse-detail-note">
                Edits below go directly to the server (no local plaintext copy). Save to apply.
            </p>
            <textarea class="paid-deck-browse-detail-editor" data-role="editor" spellcheck="false" rows="20">${PaidDeckBrowsePage.#escape(editableJsonString)}</textarea>
            <div class="paid-deck-browse-detail-error" data-role="save-error" hidden></div>
            <div class="paid-deck-browse-detail-actions">
                <button type="button" class="paid-deck-browse-detail-save" data-role="save">Save edits</button>
            </div>
        `;

        const saveButton = detailContainer.querySelector('[data-role="save"]');
        const editorTextarea = detailContainer.querySelector('[data-role="editor"]');
        const saveErrorElement = detailContainer.querySelector('[data-role="save-error"]');

        saveButton.addEventListener("click", async () =>
        {
            saveErrorElement.hidden = true;
            saveErrorElement.textContent = "";

            let parsedPlaintext;
            try
            {
                parsedPlaintext = JSON.parse(editorTextarea.value);
            }
            catch (parseError)
            {
                saveErrorElement.textContent = "Invalid JSON.";
                saveErrorElement.hidden = false;
                return;
            }

            saveButton.disabled = true;
            saveButton.textContent = "Saving…";

            const saveResult = await PaidDeckContentClient.updateEntity
            (
                this.#deckId,
                entryMetadata.type,
                entryMetadata.entityId,
                parsedPlaintext
            );

            saveButton.disabled = false;
            saveButton.textContent = "Save edits";

            if (!saveResult.success)
            {
                saveErrorElement.textContent = saveResult.reason || "Save failed.";
                saveErrorElement.hidden = false;
                return;
            }

            await DialogBox.alert("Saved", "Your edit has been stored on the server.");
        });
    }

    static #labelForEntityType(entityType)
    {
        switch (Number(entityType))
        {
            case entityTypes.DECK:           return "Deck";
            case entityTypes.CARD:           return "Card";
            case entityTypes.STUDY_MATERIAL: return "Study material";
            case entityTypes.MOCK_TEST:      return "Mock test";
            default:                          return "Item";
        }
    }

    static #escape(rawValue)
    {
        if (rawValue === null || rawValue === undefined) return "";
        return String(rawValue)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("paid-deck-browse-page", PaidDeckBrowsePage);
export default PaidDeckBrowsePage;
