import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import DeckEvents from "../../../Globals/Events/DeckEvents.js";
import PaidDeckRegistry from "../../../Globals/Classes/PaidDeckRegistry.js";
import PaidDeckLicenseSyncer from "../../../Globals/Classes/Syncing/PaidDeckLicenseSyncer.js";
import TaskProgressTracker from "../../../Globals/Classes/Task/TaskProgressTracker.js";
import LicenseConstants from "../../../Globals/Constants/LicenseConstants.js";

/**
 * ManagePaidDeckCopiesDialog
 *
 * Lets the buyer manage the independent copies of one owned paid deck: show or
 * hide each copy on the home page, delete a copy, and add another copy (up to
 * LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER). Every copy shares the deck's
 * single license + content key (so one password unlock covers all) but has its
 * own detached progress.
 *
 * The list is driven off the live deck tree (the copies that actually exist on
 * this device, which are the ones that can be shown/hidden/deleted locally),
 * with the cap derived from the synced license registry so "Add" disables
 * correctly even before a just-added copy's rows have synced down.
 */
class ManagePaidDeckCopiesDialog
{
    static show(paidDeckId)
    {
        if (typeof paidDeckId !== "string" || paidDeckId.length === 0)
        {
            return null;
        }

        const dialog = DialogBox.modal
        (`
            <style>
                .manage-copies-body
                {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    padding: 6px 16px 16px 16px;
                    min-width: min(380px, 88vw);
                }
                .manage-copies-title
                {
                    margin: 6px 0 0 0;
                    font-size: 1.15rem;
                    font-weight: 700;
                    text-align: center;
                }
                .manage-copies-subtitle
                {
                    text-align: center;
                    font-size: 13px;
                    opacity: 0.75;
                }
                .manage-copies-row
                {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 10px;
                    padding: 8px 10px;
                    border-radius: 6px;
                    border: 1px solid rgba(255, 255, 255, 0.12);
                }
                .manage-copies-label
                {
                    font-size: 14px;
                }
                .manage-copies-actions
                {
                    display: flex;
                    gap: 6px;
                }
                .manage-copies-actions button,
                .manage-copies-add
                {
                    border: none;
                    border-radius: 6px;
                    padding: 7px 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .manage-copies-add
                {
                    background-color: var(--accent-color, #1a73e8);
                    color: #fff;
                    width: 100%;
                    padding: 10px;
                    font-size: 14px;
                }
                .manage-copies-add:disabled
                {
                    opacity: 0.5;
                    cursor: default;
                }
                .manage-copies-delete
                {
                    background-color: rgba(220, 70, 70, 0.18);
                    color: rgb(235, 130, 130);
                }
                .manage-copies-empty,
                .manage-copies-note
                {
                    font-size: 12.5px;
                    opacity: 0.7;
                    text-align: center;
                }
            </style>
            <div class="manage-copies-body" data-role="body"></div>
        `);

        ManagePaidDeckCopiesDialog.#render(dialog, paidDeckId);
        return dialog;
    }

    /**
     * The copies of this paid deck that currently exist as top-level decks in
     * the local tree (sub-decks of a copy are excluded — only the copy roots).
     */
    static #getLocalCopyRoots(paidDeckId)
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            return [];
        }
        return rootDeck.getSubDecks().filter((deck) =>
        {
            const additionalData = (typeof deck.getAdditionalData === "function") ? (deck.getAdditionalData() || {}) : {};
            return additionalData.paidDeckId === paidDeckId;
        });
    }

    static #render(dialog, paidDeckId)
    {
        const body = dialog.querySelector('[data-role="body"]');
        if (!body)
        {
            return;
        }

        const localCopyRoots = ManagePaidDeckCopiesDialog.#getLocalCopyRoots(paidDeckId);
        const maxCopies = LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER;
        // The cap is per-license and enforced server-side; use the larger of the
        // synced registry count and the local count so a just-added copy whose
        // rows haven't pulled down yet still counts toward the limit.
        const copyCount = Math.max(localCopyRoots.length, PaidDeckRegistry.getInstanceCount(paidDeckId));
        const canAddCopy = copyCount < maxCopies;

        const rowsMarkup = localCopyRoots.map((deck, copyIndex) =>
        {
            const additionalData = deck.getAdditionalData() || {};
            const label = additionalData.paidDeckInstanceLabel || `Copy ${copyIndex + 1}`;
            const isHidden = additionalData.hidden === true;
            return `
                <div class="manage-copies-row">
                    <span class="manage-copies-label">${ManagePaidDeckCopiesDialog.#escape(label)}${isHidden ? " · hidden" : ""}</span>
                    <span class="manage-copies-actions">
                        <button class="manage-copies-toggle" data-deck-id="${ManagePaidDeckCopiesDialog.#escape(deck.getId())}">${isHidden ? "Show" : "Hide"}</button>
                        <button class="manage-copies-delete" data-deck-id="${ManagePaidDeckCopiesDialog.#escape(deck.getId())}">Delete</button>
                    </span>
                </div>
            `;
        }).join("");

        body.innerHTML = `
            <div class="manage-copies-title">Manage copies</div>
            <div class="manage-copies-subtitle">${copyCount} of ${maxCopies} copies</div>
            <div class="manage-copies-list">
                ${rowsMarkup || `<div class="manage-copies-empty">No copies on this device yet.</div>`}
            </div>
            <button class="manage-copies-add" ${canAddCopy ? "" : "disabled"}>Add a copy</button>
            ${canAddCopy ? "" : `<div class="manage-copies-note">You've reached the maximum of ${maxCopies} copies.</div>`}
        `;

        for (const toggleButton of body.querySelectorAll(".manage-copies-toggle"))
        {
            toggleButton.addEventListener("click", async () =>
            {
                const deck = Deck.getById(toggleButton.dataset.deckId);
                if (!deck)
                {
                    return;
                }
                const nextHidden = (deck.getAdditionalData()?.hidden !== true);
                deck.setAdditionalDataField("hidden", nextHidden);
                await deck.save();
                ManagePaidDeckCopiesDialog.#refreshHome(deck.getParent());
                ManagePaidDeckCopiesDialog.#render(dialog, paidDeckId);
            });
        }

        for (const deleteButton of body.querySelectorAll(".manage-copies-delete"))
        {
            deleteButton.addEventListener("click", async () =>
            {
                const deck = Deck.getById(deleteButton.dataset.deckId);
                if (!deck)
                {
                    return;
                }
                const deleted = await ManagePaidDeckCopiesDialog.#deleteCopy(deck, paidDeckId);
                if (deleted)
                {
                    ManagePaidDeckCopiesDialog.#render(dialog, paidDeckId);
                }
            });
        }

        const addButton = body.querySelector(".manage-copies-add");
        if (addButton && canAddCopy)
        {
            addButton.addEventListener("click", async () =>
            {
                addButton.disabled = true;
                addButton.textContent = "Adding…";
                const added = await ManagePaidDeckCopiesDialog.addCopy(paidDeckId);
                if (added)
                {
                    ManagePaidDeckCopiesDialog.#render(dialog, paidDeckId);
                }
                else
                {
                    addButton.disabled = false;
                    addButton.textContent = "Add a copy";
                }
            });
        }
    }

    /**
     * Adds a fresh copy via the server, then runs a sync so the new copy's
     * seeded rows pull down and its home tile materializes. Shared with the
     * store details page. Returns true on success.
     */
    static async addCopy(paidDeckId)
    {
        let response;
        try
        {
            response = await fetch("/PaidDecks/Copies/Add",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId })
            });
        }
        catch (networkError)
        {
            await DialogBox.alert("Couldn't add copy", `Network error: ${networkError.message}`);
            return false;
        }

        if (!response.ok)
        {
            const errorJson = await response.json().catch(() => ({}));
            const message = response.status === 409
                ? `You've reached the maximum of ${LicenseConstants.MAX_PAID_DECK_COPIES_PER_USER} copies.`
                : (errorJson.error || `HTTP ${response.status}`);
            await DialogBox.alert("Couldn't add copy", message);
            return false;
        }

        // The new copy's content arrives through the regular sync pull (not the
        // license pull), so force a sync cycle; the license-syncer also refreshes
        // the registry off the same SyncEvents.COMPLETED.
        try
        {
            await TaskProgressTracker.triggerSync();
        }
        catch (syncError)
        {
            // The copy is provisioned server-side; it'll appear on the next
            // background sync even if this forced cycle failed.
            console.warn("[ManagePaidDeckCopiesDialog] Post-add sync failed:", syncError);
        }
        await PaidDeckLicenseSyncer.pullLicenses();
        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: Deck.getRoot() } }));
        return true;
    }

    static async #deleteCopy(deck, paidDeckId)
    {
        const additionalData = deck.getAdditionalData() || {};
        const instanceId = additionalData.paidDeckInstanceId || LicenseConstants.PAID_DECK_FIRST_INSTANCE_ID;

        const confirmed = await DialogBox.confirm
        (
            "Delete this copy?",
            "This permanently removes this copy and its study progress from all your devices. Your purchase is kept — you can add a fresh copy any time while your access is valid."
        );
        if (!confirmed)
        {
            return false;
        }

        const parentDeck = deck.getParent();

        let response;
        try
        {
            response = await fetch("/PaidDecks/Copies/Delete",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ deckId: paidDeckId, instanceId: instanceId })
            });
        }
        catch (networkError)
        {
            await DialogBox.alert("Couldn't delete copy", `Network error: ${networkError.message}`);
            return false;
        }

        if (!response.ok)
        {
            const errorJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Couldn't delete copy", errorJson.error || `HTTP ${response.status}`);
            return false;
        }

        await deck.delete();
        await PaidDeckLicenseSyncer.pullLicenses();
        ManagePaidDeckCopiesDialog.#refreshHome(parentDeck);
        return true;
    }

    static #refreshHome(parentDeck)
    {
        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, { detail: { deck: parentDeck || Deck.getRoot() } }));
    }

    static #escape(rawValue)
    {
        if (rawValue === null || rawValue === undefined)
        {
            return "";
        }
        return String(rawValue)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

export default ManagePaidDeckCopiesDialog;
