import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckUploadDialog from "./Components/PaidDeckUploadDialog.js";
import PaidDeckEditDialog from "./Components/PaidDeckEditDialog.js";
import BulkApplyDialog from "./Components/BulkApplyDialog.js";
import { userRoles } from "../../Globals/Enumerations/UserRoles.js";
import { adminPanelTabs } from "../../Globals/Enumerations/AdminPanelTabs.js";

/**
 * AdminPanelPage
 *
 * Tabbed admin UI: Decks (upload/edit/list/publish/rotate/bulk-apply),
 * Pricing (per-deck per-region), Bundles (define included children +
 * discounts), Stats (revenue aggregation). All operations call
 * /Admin/* endpoints gated by the EnsureAdmin server plugin — the
 * client-side role check below is UX only; the server is the source
 * of truth.
 */
class AdminPanelPage extends HTMLElement
{
    #activeTab = adminPanelTabs.DECKS;
    #paidDecks = [];
    #selectedDeckIds = new Set();
    #adminDeckSearchQuery = "";

    async connectedCallback()
    {
        this.setAttribute("page", "");

        const currentUser = window["user"];
        if (!currentUser || currentUser.getRole() !== userRoles.ADMIN)
        {
            this.innerHTML = `
                <header-component title="Admin Panel"></header-component>
                <div class="admin-panel-denied">You don't have permission to view this page.</div>
            `;
            return;
        }

        this.innerHTML = `
            <header-component title="Admin Panel"></header-component>
            <div class="admin-panel-tabs">
                <button class="admin-panel-tab" data-tab="${adminPanelTabs.DECKS}">Decks</button>
                <button class="admin-panel-tab" data-tab="${adminPanelTabs.PRICING}">Pricing</button>
                <button class="admin-panel-tab" data-tab="${adminPanelTabs.BUNDLES}">Bundles</button>
                <button class="admin-panel-tab" data-tab="${adminPanelTabs.STATS}">Stats</button>
                <button class="admin-panel-tab" data-tab="${adminPanelTabs.ADMINS}">Admins</button>
            </div>
            <div class="admin-panel-content" data-role="content"></div>
        `;

        for (const tabButton of this.querySelectorAll(".admin-panel-tab"))
        {
            tabButton.addEventListener("click", (clickEvent) =>
            {
                this.#activeTab = Number(clickEvent.currentTarget.dataset.tab);
                this.#renderTab();
            });
        }

        this.#renderTab();
    }

    async #renderTab()
    {
        for (const tabButton of this.querySelectorAll(".admin-panel-tab"))
        {
            const tabValue = Number(tabButton.dataset.tab);
            tabButton.classList.toggle("admin-panel-tab-active", tabValue === this.#activeTab);
        }

        const content = this.querySelector('[data-role="content"]');
        content.innerHTML = `<div class="admin-panel-loading">Loading…</div>`;

        switch (this.#activeTab)
        {
            case adminPanelTabs.DECKS:
                await this.#renderDecksTab(content);
                break;
            case adminPanelTabs.PRICING:
                await this.#renderPricingTab(content);
                break;
            case adminPanelTabs.BUNDLES:
                await this.#renderBundlesTab(content);
                break;
            case adminPanelTabs.STATS:
                await this.#renderStatsTab(content);
                break;
            case adminPanelTabs.ADMINS:
                await this.#renderAdminsTab(content);
                break;
        }
    }

    async #fetchPaidDecks()
    {
        const response = await fetch("/Admin/PaidDecks/List?includeUnpublished=true");

        if (!response.ok)
        {
            throw new Error(`HTTP ${response.status}`);
        }

        const responseJson = await response.json();
        this.#paidDecks = responseJson.decks || [];

        // Prune selection of any decks that no longer exist after a refresh.
        const validIds = new Set(this.#paidDecks.map(deck => deck.id));
        for (const selectedId of Array.from(this.#selectedDeckIds))
        {
            if (!validIds.has(selectedId))
            {
                this.#selectedDeckIds.delete(selectedId);
            }
        }

        return this.#paidDecks;
    }

    #filteredDecks()
    {
        const query = this.#adminDeckSearchQuery.trim().toLowerCase();
        if (query.length === 0)
        {
            return this.#paidDecks;
        }

        return this.#paidDecks.filter(deck =>
        {
            const haystack = `${deck.title || ""} ${deck.category || ""} ${deck.id || ""}`.toLowerCase();
            return haystack.includes(query);
        });
    }

    async #renderDecksTab(content)
    {
        try
        {
            await this.#fetchPaidDecks();
        }
        catch (loadError)
        {
            content.innerHTML = `<div class="admin-panel-error">${loadError.message}</div>`;
            return;
        }

        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload">Upload new deck</button>
                <input type="search" class="admin-panel-deck-search" placeholder="Filter loaded decks by title or ID" value="${AdminPanelPage.#escape(this.#adminDeckSearchQuery)}">
                <button class="admin-panel-bulk-apply" disabled>Apply to selected (0)</button>
            </div>
            <table class="admin-panel-table">
                <thead>
                    <tr>
                        <th><input type="checkbox" class="admin-panel-select-all-decks"></th>
                        <th>Title</th>
                        <th>Category</th>
                        <th>Price</th>
                        <th>Key v</th>
                        <th>Published</th>
                        <th>Subdecks</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-role="deck-rows"></tbody>
            </table>
        `;

        this.querySelector(".admin-panel-upload").addEventListener("click", () => this.#openUploadDialog());

        const searchInput = this.querySelector(".admin-panel-deck-search");
        searchInput.addEventListener("input", () =>
        {
            this.#adminDeckSearchQuery = searchInput.value;
            this.#renderDeckRows();
        });

        const bulkApplyButton = this.querySelector(".admin-panel-bulk-apply");
        bulkApplyButton.addEventListener("click", () => this.#openBulkApplyForSelection());

        const selectAllCheckbox = this.querySelector(".admin-panel-select-all-decks");
        selectAllCheckbox.addEventListener("change", () =>
        {
            const visibleDecks = this.#filteredDecks();
            if (selectAllCheckbox.checked)
            {
                for (const deck of visibleDecks)
                {
                    this.#selectedDeckIds.add(deck.id);
                }
            }
            else
            {
                for (const deck of visibleDecks)
                {
                    this.#selectedDeckIds.delete(deck.id);
                }
            }
            this.#renderDeckRows();
        });

        this.#renderDeckRows();
    }

    #renderDeckRows()
    {
        const tbody = this.querySelector('[data-role="deck-rows"]');
        if (!tbody) return;

        const visibleDecks = this.#filteredDecks();

        tbody.innerHTML = visibleDecks.map(deck =>
        {
            const isSelected = this.#selectedDeckIds.has(deck.id);
            const subdeckCount = Array.isArray(deck.bundleChildIds) ? deck.bundleChildIds.length : 0;
            const currency = deck.currency || "INR";
            const priceLabel = `${currency} ${((deck.basePriceMinor || 0) / 100).toFixed(2)}`;

            return `
                <tr data-deck-id="${AdminPanelPage.#escape(deck.id)}">
                    <td><input type="checkbox" class="admin-panel-deck-select" data-deck-id="${AdminPanelPage.#escape(deck.id)}" ${isSelected ? "checked" : ""}></td>
                    <td>${AdminPanelPage.#escape(deck.title)}</td>
                    <td>${AdminPanelPage.#escape(deck.category)}</td>
                    <td>${priceLabel}</td>
                    <td>${deck.keyVersion}</td>
                    <td>${deck.isPublished ? "✓" : ""}</td>
                    <td>${subdeckCount > 0 ? subdeckCount : ""}</td>
                    <td>
                        <button data-action="edit" data-deck-id="${AdminPanelPage.#escape(deck.id)}">Edit</button>
                        <button data-action="publish" data-deck-id="${AdminPanelPage.#escape(deck.id)}">${deck.isPublished ? "Unpublish" : "Publish"}</button>
                        <button data-action="rotate" data-deck-id="${AdminPanelPage.#escape(deck.id)}">Rotate key</button>
                        ${subdeckCount > 0 ? `<button data-action="apply-to-subdecks" data-deck-id="${AdminPanelPage.#escape(deck.id)}">Apply to subdecks</button>` : ""}
                    </td>
                </tr>
            `;
        }).join("");

        for (const checkbox of this.querySelectorAll(".admin-panel-deck-select"))
        {
            checkbox.addEventListener("change", () =>
            {
                const deckId = checkbox.dataset.deckId;
                if (checkbox.checked)
                {
                    this.#selectedDeckIds.add(deckId);
                }
                else
                {
                    this.#selectedDeckIds.delete(deckId);
                }
                this.#refreshBulkApplyButton();
            });
        }

        for (const actionButton of this.querySelectorAll("[data-action]"))
        {
            actionButton.addEventListener("click", (clickEvent) =>
            {
                const action = clickEvent.currentTarget.dataset.action;
                const deckId = clickEvent.currentTarget.dataset.deckId;
                this.#handleRowAction(action, deckId);
            });
        }

        this.#refreshBulkApplyButton();
    }

    #refreshBulkApplyButton()
    {
        const button = this.querySelector(".admin-panel-bulk-apply");
        if (!button) return;

        const count = this.#selectedDeckIds.size;
        button.disabled = count === 0;
        button.textContent = `Apply to selected (${count})`;
    }

    async #handleRowAction(action, deckId)
    {
        const deck = this.#paidDecks.find(entry => entry.id === deckId);
        if (!deck) return;

        switch (action)
        {
            case "edit":
            {
                const saved = await PaidDeckEditDialog.show(deck);
                if (saved) await this.#renderTab();
                break;
            }
            case "publish":
            {
                await this.#togglePublish(deck);
                break;
            }
            case "rotate":
            {
                await this.#rotateKey(deck.id);
                break;
            }
            case "apply-to-subdecks":
            {
                const applied = await BulkApplyDialog.show
                ({
                    title: `Apply to subdecks of ${deck.title}`,
                    deckIds: Array.isArray(deck.bundleChildIds) ? deck.bundleChildIds : []
                });
                if (applied) await this.#renderTab();
                break;
            }
        }
    }

    async #openUploadDialog()
    {
        const uploaded = await PaidDeckUploadDialog.show();
        if (uploaded) await this.#renderTab();
    }

    async #openBulkApplyForSelection()
    {
        const deckIds = Array.from(this.#selectedDeckIds);
        const applied = await BulkApplyDialog.show
        ({
            title: `Apply to ${deckIds.length} selected deck${deckIds.length === 1 ? "" : "s"}`,
            deckIds: deckIds
        });
        if (applied)
        {
            this.#selectedDeckIds.clear();
            await this.#renderTab();
        }
    }

    async #rotateKey(deckId)
    {
        const response = await fetch("/Admin/PaidDecks/RotateKey",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deckId })
        });

        const responseJson = await response.json().catch(() => ({}));
        await DialogBox.alert(response.ok ? "Key rotated" : "Rotation failed", JSON.stringify(responseJson, null, 2));
        await this.#renderTab();
    }

    async #togglePublish(deck)
    {
        const response = await fetch("/Admin/PaidDecks/Update",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: deck.id, updates: { isPublished: !deck.isPublished } })
        });

        if (response.ok)
        {
            await this.#renderTab();
        }
        else
        {
            await DialogBox.alert("Update failed", `HTTP ${response.status}`);
        }
    }

    async #renderPricingTab(content)
    {
        await this.#fetchPaidDecks();

        content.innerHTML = `
            <p>Set per-region pricing for each deck. Multiple rows per deck supported with effective windows.</p>
            <select class="admin-panel-pricing-deck">
                ${this.#paidDecks.map(deck => `<option value="${AdminPanelPage.#escape(deck.id)}">${AdminPanelPage.#escape(deck.title)}</option>`).join("")}
            </select>
            <div class="admin-panel-pricing-form">
                <label>Region (e.g. IN, US, GLOBAL): <input class="admin-panel-pricing-region" value="IN"></label>
                <label>Price (minor units): <input type="number" class="admin-panel-pricing-amount" value="0"></label>
                <label>Currency: <input class="admin-panel-pricing-currency" value="INR"></label>
                <label>Discount %: <input type="number" class="admin-panel-pricing-discount" value="0"></label>
                <button class="admin-panel-pricing-save">Save pricing</button>
            </div>
            <p class="admin-panel-pricing-note">
                Pricing is currently set manually. The future PricingOptimizer (Python) will
                also write to this same table — manual overrides will coexist via effective
                date windows.
            </p>
        `;

        this.querySelector(".admin-panel-pricing-save").addEventListener("click", async () =>
        {
            const deckId = this.querySelector(".admin-panel-pricing-deck").value;
            const region = this.querySelector(".admin-panel-pricing-region").value.toUpperCase();
            const priceMinor = parseInt(this.querySelector(".admin-panel-pricing-amount").value || "0", 10);
            const currency = this.querySelector(".admin-panel-pricing-currency").value.toUpperCase();
            const discountPercent = parseFloat(this.querySelector(".admin-panel-pricing-discount").value || "0");

            const response = await fetch("/Admin/PaidDecks/Pricing",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    deckId: deckId,
                    pricings: [{ region, priceMinor, currency, discountPercent }]
                })
            });

            if (response.ok)
            {
                await DialogBox.alert("Saved", "Pricing saved.");
            }
            else
            {
                await DialogBox.alert("Failed", `HTTP ${response.status}`);
            }
        });
    }

    async #renderBundlesTab(content)
    {
        await this.#fetchPaidDecks();

        content.innerHTML = `
            <p>Define a bundle deck's included children. Setting "discount when included" to 100 means the user gets full credit toward the bundle for owning that child.</p>
            <label>Bundle deck:
                <select class="admin-panel-bundle-parent">
                    ${this.#paidDecks.map(deck => `<option value="${AdminPanelPage.#escape(deck.id)}">${AdminPanelPage.#escape(deck.title)}</option>`).join("")}
                </select>
            </label>
            <div class="admin-panel-bundle-children">
                ${this.#paidDecks.map(deck => `
                    <label class="admin-panel-bundle-row">
                        <input type="checkbox" data-deck-id="${AdminPanelPage.#escape(deck.id)}">
                        ${AdminPanelPage.#escape(deck.title)}
                        <input type="number" data-discount-for="${AdminPanelPage.#escape(deck.id)}" value="100" min="0" max="100" style="width: 60px">%
                    </label>
                `).join("")}
            </div>
            <button class="admin-panel-bundle-save">Save bundle</button>
        `;

        this.querySelector(".admin-panel-bundle-save").addEventListener("click", async () =>
        {
            const bundleDeckId = this.querySelector(".admin-panel-bundle-parent").value;
            const includedDecks = [];

            for (const checkbox of this.querySelectorAll(".admin-panel-bundle-row input[type=checkbox]"))
            {
                if (!checkbox.checked) continue;
                const childId = checkbox.dataset.deckId;
                const discountInput = this.querySelector(`[data-discount-for="${childId}"]`);
                includedDecks.push
                ({
                    includedDeckId: childId,
                    discountPercentWhenIncluded: parseFloat(discountInput.value || "100")
                });
            }

            const response = await fetch("/Admin/PaidDecks/Bundle",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ bundleDeckId, includedDecks })
            });

            if (response.ok)
            {
                await DialogBox.alert("Saved", "Bundle saved.");
            }
            else
            {
                await DialogBox.alert("Failed", `HTTP ${response.status}`);
            }
        });
    }

    async #renderStatsTab(content)
    {
        content.innerHTML = `<div class="admin-panel-loading">Loading stats…</div>`;

        try
        {
            const response = await fetch("/Admin/Stats/Revenue?groupBy=deck");

            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }

            const responseJson = await response.json();
            const rows = responseJson.results || [];

            content.innerHTML = `
                <p>Revenue by deck (${responseJson.from} → ${responseJson.to})</p>
                <table class="admin-panel-table">
                    <thead><tr><th>Deck ID</th><th>Purchases</th><th>Total (minor)</th></tr></thead>
                    <tbody>
                        ${rows.map(row => `<tr><td>${AdminPanelPage.#escape(row._id)}</td><td>${row.purchaseCount}</td><td>${row.totalMinor}</td></tr>`).join("")}
                    </tbody>
                </table>
                <p class="admin-panel-stats-note">
                    Once the PricingOptimizer ships, this aggregation will feed its
                    region-aware margin model directly.
                </p>
            `;
        }
        catch (statsError)
        {
            content.innerHTML = `<div class="admin-panel-error">${statsError.message}</div>`;
        }
    }

    async #renderAdminsTab(content)
    {
        content.innerHTML = `<div class="admin-panel-loading">Loading admins…</div>`;

        let admins;
        try
        {
            const response = await fetch("/Admin/AdminEmails");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }
            const responseJson = await response.json();
            admins = Array.isArray(responseJson.admins) ? responseJson.admins : [];
        }
        catch (loadError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(loadError.message)}</div>`;
            return;
        }

        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-admin">Add admin</button>
            </div>
            <table class="admin-panel-table">
                <thead>
                    <tr>
                        <th>Email</th>
                        <th>Added by</th>
                        <th>Added at</th>
                        <th>Notes</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-role="admin-rows"></tbody>
            </table>
            <p class="admin-panel-pricing-note">
                Adding an email here promotes that user to ADMIN on their next login.
                Existing admins keep their role until they log in again. Removing your
                own email is blocked server-side to avoid self-lockout, and the last
                remaining admin row cannot be deleted.
            </p>
        `;

        this.querySelector('[data-role="add-admin"]').addEventListener("click", async () =>
        {
            const added = await this.#openAddAdminDialog();
            if (added)
            {
                await this.#renderTab();
            }
        });

        this.#renderAdminRows(admins);
    }

    #renderAdminRows(admins)
    {
        const tbody = this.querySelector('[data-role="admin-rows"]');
        if (!tbody)
        {
            return;
        }

        if (admins.length === 0)
        {
            tbody.innerHTML = `<tr><td colspan="5" class="admin-panel-loading">No admins configured.</td></tr>`;
            return;
        }

        tbody.innerHTML = admins.map((admin) =>
        {
            const addedAtDate = admin.addedAt ? new Date(admin.addedAt) : null;
            const addedAtLabel = (addedAtDate && !Number.isNaN(addedAtDate.getTime()))
                ? addedAtDate.toLocaleDateString()
                : "";

            return `
                <tr data-email="${AdminPanelPage.#escape(admin.email)}">
                    <td>${AdminPanelPage.#escape(admin.email)}</td>
                    <td>${AdminPanelPage.#escape(admin.addedBy || "")}</td>
                    <td>${AdminPanelPage.#escape(addedAtLabel)}</td>
                    <td>${AdminPanelPage.#escape(admin.notes || "")}</td>
                    <td>
                        <button data-action="remove-admin" data-email="${AdminPanelPage.#escape(admin.email)}">Remove</button>
                    </td>
                </tr>
            `;
        }).join("");

        for (const removeButton of this.querySelectorAll('[data-action="remove-admin"]'))
        {
            removeButton.addEventListener("click", (clickEvent) =>
            {
                const targetEmail = clickEvent.currentTarget.dataset.email;
                this.#handleRemoveAdmin(targetEmail);
            });
        }
    }

    async #openAddAdminDialog()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog">
                    <h2 class="admin-panel-add-title">Add admin email</h2>
                    <p class="admin-panel-add-subtitle">
                        The target user will be promoted to ADMIN on their next login.
                    </p>
                    <label class="admin-panel-add-field">
                        <span>Email</span>
                        <input type="email" class="admin-panel-add-email" placeholder="name@example.com" autocomplete="off">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Notes (optional)</span>
                        <textarea class="admin-panel-add-notes" rows="3" placeholder="Why this person needs admin access"></textarea>
                    </label>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit">Add admin</button>
                    </div>
                </div>
            `);

            const emailInput = dialog.querySelector(".admin-panel-add-email");
            const notesInput = dialog.querySelector(".admin-panel-add-notes");
            const errorElement = dialog.querySelector('[data-role="error"]');

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            dialog.querySelector(".admin-panel-add-submit").addEventListener("click", async () =>
            {
                const rawEmail = emailInput.value.trim();
                if (rawEmail.length === 0 || rawEmail.indexOf("@") < 0)
                {
                    errorElement.textContent = "Enter a valid email address.";
                    errorElement.hidden = false;
                    return;
                }

                errorElement.hidden = true;
                const response = await fetch("/Admin/AdminEmails/Add",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email: rawEmail, notes: notesInput.value })
                });

                if (!response.ok)
                {
                    const responseJson = await response.json().catch(() => ({}));
                    errorElement.textContent = responseJson.error || `HTTP ${response.status}`;
                    errorElement.hidden = false;
                    return;
                }

                dialog.close();
                resolve(true);
            });

            emailInput.focus();
        });
    }

    async #handleRemoveAdmin(targetEmail)
    {
        if (!targetEmail)
        {
            return;
        }
        const confirmed = await DialogBox.confirm("Remove admin", `Remove ${targetEmail} from the admin allowlist?`);
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Admin/AdminEmails/Remove",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: targetEmail })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Could not remove", responseJson.error || `HTTP ${response.status}`);
            return;
        }

        await this.#renderTab();
    }

    static #escape(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("admin-panel-page", AdminPanelPage);
export default AdminPanelPage;
