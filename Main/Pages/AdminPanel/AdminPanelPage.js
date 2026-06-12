import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import PaidDeckUploadDialog from "./Components/PaidDeckUploadDialog.js";
import PaidDeckEditDialog from "./Components/PaidDeckEditDialog.js";
import BulkApplyDialog from "./Components/BulkApplyDialog.js";
import CreateOrganizationDialog from "./Components/CreateOrganizationDialog.js";
import OrganizationDetailsDialog from "./Components/OrganizationDetailsDialog.js";
import AddMembersDialog from "./Components/AddMembersDialog.js";
import AlertNotifier from "./Components/AlertNotifier.js";
import CreditConfigEditor from "./Components/CreditConfigEditor.js";
import { userRoles } from "../../Globals/Enumerations/UserRoles.js";
import { alertSeverity } from "../../Globals/Enumerations/AlertSeverity.js";
import { adminPanelTabs } from "../../Globals/Enumerations/AdminPanelTabs.js";
import { semVerBumpTypes } from "../../Globals/Enumerations/SemVerBumpTypes.js";
import { organizationStatus } from "../../Globals/Enumerations/OrganizationStatus.js";

/**
 * AdminPanelPage
 *
 * Tabbed admin UI: Decks (upload/edit/list/publish/rotate/bulk-apply —
 * regional pricing is authored inline in the upload dialog), Stats (revenue
 * aggregation), Admins, Release Notes, Organizations, Alerts (the operational
 * alert log + browser-notification opt-in), and Rate Limits (the server-side
 * 429 event log). All operations call /Admin/* endpoints gated by the
 * EnsureAdmin server plugin — the client-side role check below is UX only;
 * the server is the source of truth.
 */
class AdminPanelPage extends HTMLElement
{
    #activeTab = adminPanelTabs.DECKS;
    #paidDecks = [];
    #selectedDeckIds = new Set();
    #adminDeckSearchQuery = "";
    #organizations = [];
    #selectedMemberOrganizationId = "";
    #organizationMembers = [];
    #selectedMemberIds = new Set();

    async connectedCallback()
    {
        this.setAttribute("page", "");

        const currentUser = window["user"];
        const isSuperAdmin = currentUser && currentUser.getRole() === userRoles.ADMIN;
        const isOrganizationAdmin = currentUser && currentUser.getRole() === userRoles.ORG_ADMIN;

        if (!currentUser || (!isSuperAdmin && !isOrganizationAdmin))
        {
            this.innerHTML = `
                <header-component title="Admin Panel"></header-component>
                <div class="admin-panel-denied">You don't have permission to view this page.</div>
            `;
            return;
        }

        // Org-admin users see only the Members tab — no decks, pricing,
        // bundles, stats, admin allowlist, release notes, or super-admin
        // org management. The backend re-enforces every restriction.
        const superAdminTabs =
        [
            { tab: adminPanelTabs.DECKS, label: "Decks" },
            { tab: adminPanelTabs.STATS, label: "Stats" },
            { tab: adminPanelTabs.ADMINS, label: "Admins" },
            { tab: adminPanelTabs.RELEASE_NOTES, label: "Release Notes" },
            { tab: adminPanelTabs.ORGANIZATIONS, label: "Organizations" },
            { tab: adminPanelTabs.ALERTS, label: "Alerts" },
            { tab: adminPanelTabs.RATE_LIMITS, label: "Rate Limits" },
            { tab: adminPanelTabs.AUDIT_LOG, label: "Audit Log" },
            { tab: adminPanelTabs.CREDITS, label: "Credits" }
        ];
        const organizationAdminTabs =
        [
            { tab: adminPanelTabs.ORGANIZATION_MEMBERS, label: "Members" }
        ];
        const visibleTabs = isSuperAdmin ? superAdminTabs : organizationAdminTabs;

        this.#activeTab = isSuperAdmin ? adminPanelTabs.DECKS : adminPanelTabs.ORGANIZATION_MEMBERS;

        this.innerHTML = `
            <header-component title="Admin Panel"></header-component>
            <div class="admin-panel-tabs">
                ${visibleTabs.map(entry => `<button class="admin-panel-tab" data-tab="${entry.tab}">${entry.label}</button>`).join("")}
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
        // Guard: only render tabs the current user's role is allowed to
        // see. The tab buttons are filtered at construction so a click
        // can't reach this method for a forbidden tab in normal use —
        // this is the defence in depth for code paths that set
        // this.#activeTab directly.
        const currentUser = window["user"];
        const isSuperAdmin = currentUser && currentUser.getRole() === userRoles.ADMIN;
        const allowedTabs = isSuperAdmin
            ? new Set([adminPanelTabs.DECKS, adminPanelTabs.STATS, adminPanelTabs.ADMINS, adminPanelTabs.RELEASE_NOTES, adminPanelTabs.ORGANIZATIONS, adminPanelTabs.ALERTS, adminPanelTabs.RATE_LIMITS, adminPanelTabs.AUDIT_LOG, adminPanelTabs.CREDITS])
            : new Set([adminPanelTabs.ORGANIZATION_MEMBERS]);

        if (!allowedTabs.has(this.#activeTab))
        {
            return;
        }

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
            case adminPanelTabs.STATS:
                await this.#renderStatsTab(content);
                break;
            case adminPanelTabs.ADMINS:
                await this.#renderAdminsTab(content);
                break;
            case adminPanelTabs.RELEASE_NOTES:
                await this.#renderReleaseNotesTab(content);
                break;
            case adminPanelTabs.ORGANIZATIONS:
                await this.#renderOrganizationsTab(content);
                break;
            case adminPanelTabs.ALERTS:
                await this.#renderAlertsTab(content);
                break;
            case adminPanelTabs.RATE_LIMITS:
                await this.#renderRateLimitsTab(content);
                break;
            case adminPanelTabs.AUDIT_LOG:
                await this.#renderAuditLogTab(content);
                break;
            case adminPanelTabs.CREDITS:
                this.#renderCreditsTab(content);
                break;
            case adminPanelTabs.ORGANIZATION_MEMBERS:
                await this.#renderOrganizationMembersTab(content);
                break;
        }
    }

    #renderCreditsTab(content)
    {
        // The credits editor is a self-contained Web Component — it loads
        // /Admin/Credits/Config, renders the per-task / storage / reward
        // editors, and saves back via /Admin/Credits/Config/Save.
        content.innerHTML = "";
        content.appendChild(document.createElement("credit-config-editor"));
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

    async #renderAlertsTab(content)
    {
        // Visiting the tab is a good moment to make sure the background
        // notifier is running for this admin session.
        AlertNotifier.start();

        try
        {
            const response = await fetch("/Admin/Alerts/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }
            const responseJson = await response.json();
            const alerts = Array.isArray(responseJson.alerts) ? responseJson.alerts : [];

            content.innerHTML = `
                <div class="admin-panel-alerts-toolbar">
                    <button class="admin-panel-alerts-notify" data-role="enable-notifications"></button>
                    <span class="admin-panel-alerts-notify-state" data-role="notify-state"></span>
                </div>
                <table class="admin-panel-table admin-panel-alerts-table">
                    <thead><tr><th>Severity</th><th>Source</th><th>Title</th><th>Message</th><th>Count</th><th>Last seen</th><th></th></tr></thead>
                    <tbody>${this.#renderAlertRows(alerts)}</tbody>
                </table>
            `;

            this.#refreshNotifyButton();
            this.querySelector('[data-role="enable-notifications"]').addEventListener("click", async () =>
            {
                await AlertNotifier.requestPermission();
                AlertNotifier.start();
                this.#refreshNotifyButton();
            });

            this.#bindAlertRowActions(content);

            // First visit and no decision yet — prompt once.
            if (AlertNotifier.getPermission() === "default")
            {
                AlertNotifier.requestPermission().then(() => this.#refreshNotifyButton());
            }
        }
        catch (alertsError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(alertsError.message)}</div>`;
        }
    }

    #refreshNotifyButton()
    {
        const button = this.querySelector('[data-role="enable-notifications"]');
        const stateLabel = this.querySelector('[data-role="notify-state"]');
        if (!button) return;

        const permission = AlertNotifier.getPermission();
        if (permission === "granted")
        {
            button.textContent = "Browser notifications enabled";
            button.disabled = true;
        }
        else if (permission === "denied")
        {
            button.textContent = "Notifications blocked";
            button.disabled = true;
        }
        else if (permission === "unsupported")
        {
            button.textContent = "Notifications unsupported";
            button.disabled = true;
        }
        else
        {
            button.textContent = "Enable browser notifications";
            button.disabled = false;
        }

        if (stateLabel)
        {
            stateLabel.textContent = permission === "denied"
                ? "Re-enable notifications for this site in your browser settings."
                : "";
        }
    }

    #renderAlertRows(alerts)
    {
        if (!alerts.length)
        {
            return `<tr><td colspan="7" class="admin-panel-alerts-empty">No alerts.</td></tr>`;
        }
        return alerts.map((alert) =>
        {
            const severityClass = alert.severity === alertSeverity.ERROR
                ? "admin-panel-alert-severity-error"
                : alert.severity === alertSeverity.WARNING
                    ? "admin-panel-alert-severity-warning"
                    : "admin-panel-alert-severity-info";
            const severityLabel = alert.severity === alertSeverity.ERROR
                ? "ERROR"
                : alert.severity === alertSeverity.WARNING ? "WARN" : "INFO";
            const lastSeen = alert.lastSeenAt ? new Date(alert.lastSeenAt).toLocaleString() : "";
            return `
                <tr>
                    <td><span class="admin-panel-alert-severity ${severityClass}">${severityLabel}</span></td>
                    <td>${AdminPanelPage.#escape(alert.source || "")}</td>
                    <td>${AdminPanelPage.#escape(alert.title || "")}</td>
                    <td class="admin-panel-alert-message">${AdminPanelPage.#escape(alert.message || "")}</td>
                    <td>${alert.occurrenceCount || 1}</td>
                    <td>${AdminPanelPage.#escape(lastSeen)}</td>
                    <td class="admin-panel-alert-actions">
                        <button data-role="acknowledge-alert" data-alert-id="${AdminPanelPage.#escape(alert.id)}">Acknowledge</button>
                        <button data-role="delete-alert" data-alert-id="${AdminPanelPage.#escape(alert.id)}">Delete</button>
                    </td>
                </tr>
            `;
        }).join("");
    }

    #bindAlertRowActions(content)
    {
        for (const button of content.querySelectorAll('[data-role="acknowledge-alert"]'))
        {
            button.addEventListener("click", () => this.#postAlertAction("/Admin/Alerts/Acknowledge", button.dataset.alertId));
        }
        for (const button of content.querySelectorAll('[data-role="delete-alert"]'))
        {
            button.addEventListener("click", () => this.#postAlertAction("/Admin/Alerts/Delete", button.dataset.alertId));
        }
    }

    async #postAlertAction(endpoint, alertId)
    {
        const response = await fetch(endpoint,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: alertId })
        });

        if (response.ok)
        {
            await this.#renderAlertsTab(this.querySelector('[data-role="content"]'));
        }
        else
        {
            await DialogBox.alert("Failed", `HTTP ${response.status}`);
        }
    }

    async #renderRateLimitsTab(content)
    {
        try
        {
            const response = await fetch("/Admin/RateLimits/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }

            const responseJson = await response.json();
            const events = Array.isArray(responseJson.events) ? responseJson.events : [];
            const summary = responseJson.summary || {};

            content.innerHTML = `
                <div class="admin-panel-ratelimits-summary">
                    <span><strong>${summary.last24HourCount || 0}</strong> 429s in the last 24h</span>
                    <span><strong>${summary.shown || events.length}</strong> shown</span>
                    <span><strong>${summary.distinctIdentities || 0}</strong> distinct identities</span>
                </div>
                <table class="admin-panel-table admin-panel-ratelimits-table">
                    <thead><tr><th>When</th><th>Scope</th><th>Endpoint</th><th>Method</th><th>Identity</th><th>Retry-After</th></tr></thead>
                    <tbody>${this.#renderRateLimitRows(events)}</tbody>
                </table>
            `;
        }
        catch (rateLimitsError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(rateLimitsError.message)}</div>`;
        }
    }

    #renderRateLimitRows(events)
    {
        if (!events.length)
        {
            return `<tr><td colspan="6" class="admin-panel-ratelimits-empty">No rate-limit events recorded.</td></tr>`;
        }

        return events.map((event) =>
        {
            const occurredAt = event.occurredAt ? new Date(event.occurredAt).toLocaleString() : "";
            const scopeLabel = event.scope === "PER_USER" ? "Per-user" : "Overall";
            const scopeClass = event.scope === "PER_USER" ? "admin-panel-ratelimit-scope-user" : "admin-panel-ratelimit-scope-overall";
            const identity = event.userId
                ? `user ${event.userId}`
                : (event.ipAddress ? `ip ${event.ipAddress}` : (event.identityKey || ""));
            const retryAfter = event.retryAfterSeconds !== null && event.retryAfterSeconds !== undefined
                ? `${event.retryAfterSeconds}s`
                : "";

            return `
                <tr>
                    <td>${AdminPanelPage.#escape(occurredAt)}</td>
                    <td><span class="admin-panel-ratelimit-scope ${scopeClass}">${scopeLabel}</span></td>
                    <td class="admin-panel-ratelimit-endpoint">${AdminPanelPage.#escape(event.endpoint || "")}</td>
                    <td>${AdminPanelPage.#escape(event.method || "")}</td>
                    <td>${AdminPanelPage.#escape(identity)}</td>
                    <td>${AdminPanelPage.#escape(retryAfter)}</td>
                </tr>
            `;
        }).join("");
    }

    async #renderAuditLogTab(content)
    {
        try
        {
            const response = await fetch("/Admin/Audit/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }

            const responseJson = await response.json();
            const events = Array.isArray(responseJson.events) ? responseJson.events : [];
            const summary = responseJson.summary || {};

            content.innerHTML = `
                <div class="admin-panel-ratelimits-summary">
                    <span><strong>${summary.last24HourCount || 0}</strong> admin actions in the last 24h</span>
                    <span><strong>${summary.shown || events.length}</strong> shown</span>
                    <span><strong>${summary.distinctActors || 0}</strong> distinct admins</span>
                </div>
                <table class="admin-panel-table admin-panel-ratelimits-table">
                    <thead><tr><th>When</th><th>Outcome</th><th>Admin</th><th>Action</th><th>Method</th><th>Status</th><th>IP</th></tr></thead>
                    <tbody>${this.#renderAuditRows(events)}</tbody>
                </table>
            `;
        }
        catch (auditError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(auditError.message)}</div>`;
        }
    }

    #renderAuditRows(events)
    {
        if (!events.length)
        {
            return `<tr><td colspan="7" class="admin-panel-ratelimits-empty">No admin actions recorded.</td></tr>`;
        }

        return events.map((event) =>
        {
            const occurredAt = event.occurredAt ? new Date(event.occurredAt).toLocaleString() : "";
            const isSuccess = event.outcome === "SUCCESS";
            const outcomeLabel = isSuccess ? "Success" : "Blocked / Error";
            const outcomeClass = isSuccess ? "admin-panel-ratelimit-scope-overall" : "admin-panel-ratelimit-scope-user";
            const actor = event.actorEmail
                ? event.actorEmail
                : (event.actorUserId ? `user ${event.actorUserId}` : "anonymous");

            return `
                <tr>
                    <td>${AdminPanelPage.#escape(occurredAt)}</td>
                    <td><span class="admin-panel-ratelimit-scope ${outcomeClass}">${outcomeLabel}</span></td>
                    <td>${AdminPanelPage.#escape(actor)}</td>
                    <td class="admin-panel-ratelimit-endpoint">${AdminPanelPage.#escape(event.endpoint || "")}</td>
                    <td>${AdminPanelPage.#escape(event.method || "")}</td>
                    <td>${AdminPanelPage.#escape(String(event.statusCode || ""))}</td>
                    <td>${AdminPanelPage.#escape(event.ipAddress || "")}</td>
                </tr>
            `;
        }).join("");
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

    async #renderReleaseNotesTab(content)
    {
        content.innerHTML = `<div class="admin-panel-loading">Loading release notes…</div>`;

        let notes;
        try
        {
            const response = await fetch("/Admin/ReleaseNotes/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }
            const responseJson = await response.json();
            notes = Array.isArray(responseJson.notes) ? responseJson.notes : [];
        }
        catch (loadError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(loadError.message)}</div>`;
            return;
        }

        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-release-note">Add release note</button>
            </div>
            <table class="admin-panel-table">
                <thead>
                    <tr>
                        <th>Version</th>
                        <th>Title</th>
                        <th>Release date</th>
                        <th>Created at</th>
                        <th>Updated at</th>
                        <th>Visibility</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-role="release-note-rows"></tbody>
            </table>
            <p class="admin-panel-pricing-note">
                Versions are auto-managed — pick Major / Minor / Patch and the next
                semver is computed from the highest existing version (first ever is
                always 1.0.0). Editing a note never re-notifies users because the
                version is locked once issued. Notes flagged "Test" are visible only
                to admins (auto-popup, sidebar, this tab) — flip the flag off in the
                edit dialog to release.
            </p>
        `;

        this.querySelector('[data-role="add-release-note"]').addEventListener("click", async () =>
        {
            const created = await this.#openCreateReleaseNoteDialog();
            if (created)
            {
                await this.#renderTab();
            }
        });

        this.#renderReleaseNoteRows(notes);
    }

    #renderReleaseNoteRows(notes)
    {
        const tbody = this.querySelector('[data-role="release-note-rows"]');
        if (!tbody)
        {
            return;
        }

        if (notes.length === 0)
        {
            tbody.innerHTML = `<tr><td colspan="7" class="admin-panel-loading">No release notes yet.</td></tr>`;
            return;
        }

        const formatDate = (value) =>
        {
            if (!value) return "";
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
        };

        tbody.innerHTML = notes.map((note) =>
        {
            const visibilityLabel = note.test === true ? "Test (admins only)" : "Live";
            return `
                <tr data-note-id="${AdminPanelPage.#escape(note.id)}">
                    <td>${AdminPanelPage.#escape(note.version)}</td>
                    <td>${AdminPanelPage.#escape(note.title)}</td>
                    <td>${AdminPanelPage.#escape(formatDate(note.releaseDate))}</td>
                    <td>${AdminPanelPage.#escape(formatDate(note.createdAt))}</td>
                    <td>${AdminPanelPage.#escape(formatDate(note.updatedAt))}</td>
                    <td>${AdminPanelPage.#escape(visibilityLabel)}</td>
                    <td>
                        <button data-action="edit-release-note" data-note-id="${AdminPanelPage.#escape(note.id)}">Edit</button>
                        <button data-action="delete-release-note" data-note-id="${AdminPanelPage.#escape(note.id)}">Delete</button>
                    </td>
                </tr>
            `;
        }).join("");

        for (const editButton of this.querySelectorAll('[data-action="edit-release-note"]'))
        {
            editButton.addEventListener("click", async (clickEvent) =>
            {
                const noteId = clickEvent.currentTarget.dataset.noteId;
                const note = notes.find(candidate => candidate.id === noteId);
                if (!note) return;
                const updated = await this.#openEditReleaseNoteDialog(note);
                if (updated)
                {
                    await this.#renderTab();
                }
            });
        }

        for (const deleteButton of this.querySelectorAll('[data-action="delete-release-note"]'))
        {
            deleteButton.addEventListener("click", async (clickEvent) =>
            {
                const noteId = clickEvent.currentTarget.dataset.noteId;
                const note = notes.find(candidate => candidate.id === noteId);
                if (!note) return;
                await this.#handleDeleteReleaseNote(note);
            });
        }
    }

    async #openCreateReleaseNoteDialog()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog">
                    <h2 class="admin-panel-add-title">Add release note</h2>
                    <p class="admin-panel-add-subtitle">
                        Pick a bump type — the next version is computed automatically.
                        The release date is stamped to today and can be edited later.
                    </p>
                    <label class="admin-panel-add-field">
                        <span>Title</span>
                        <input type="text" class="release-note-title" placeholder="What changed in this release" maxlength="256" autocomplete="off">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Bump type</span>
                        <select class="release-note-bump-type">
                            <option value="${semVerBumpTypes.MAJOR}">Major (X.0.0)</option>
                            <option value="${semVerBumpTypes.MINOR}" selected>Minor (x.Y.0)</option>
                            <option value="${semVerBumpTypes.PATCH}">Patch (x.y.Z)</option>
                        </select>
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Content (HTML)</span>
                        <textarea class="release-note-content" rows="12" placeholder="<p>What's new…</p>" maxlength="200000"></textarea>
                    </label>
                    <label class="admin-panel-add-field admin-panel-add-checkbox">
                        <input type="checkbox" class="release-note-test">
                        <span>Test only (visible to admins, not regular users)</span>
                    </label>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit">Publish</button>
                    </div>
                </div>
            `);

            const titleInput = dialog.querySelector(".release-note-title");
            const bumpTypeInput = dialog.querySelector(".release-note-bump-type");
            const contentInput = dialog.querySelector(".release-note-content");
            const testInput = dialog.querySelector(".release-note-test");
            const errorElement = dialog.querySelector('[data-role="error"]');

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            dialog.querySelector(".admin-panel-add-submit").addEventListener("click", async () =>
            {
                const title = titleInput.value.trim();
                if (title.length === 0)
                {
                    errorElement.textContent = "Title is required.";
                    errorElement.hidden = false;
                    return;
                }

                errorElement.hidden = true;
                const response = await fetch("/Admin/ReleaseNotes/Create",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify
                    ({
                        title,
                        contentHtml: contentInput.value,
                        bumpType: Number(bumpTypeInput.value),
                        test: testInput.checked
                    })
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

            titleInput.focus();
        });
    }

    async #openEditReleaseNoteDialog(note)
    {
        return new Promise((resolve) =>
        {
            const releaseDateValue = note.releaseDate
                ? new Date(note.releaseDate).toISOString().slice(0, 10)
                : "";

            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog">
                    <h2 class="admin-panel-add-title">Edit release note ${AdminPanelPage.#escape(note.version)}</h2>
                    <p class="admin-panel-add-subtitle">
                        The version is locked — editing only fixes typos in title,
                        date, or HTML. Users who have already seen this note will
                        not be re-notified.
                    </p>
                    <label class="admin-panel-add-field">
                        <span>Title</span>
                        <input type="text" class="release-note-title" maxlength="256" autocomplete="off">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Release date</span>
                        <input type="date" class="release-note-date">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Content (HTML)</span>
                        <textarea class="release-note-content" rows="12" maxlength="200000"></textarea>
                    </label>
                    <label class="admin-panel-add-field admin-panel-add-checkbox">
                        <input type="checkbox" class="release-note-test">
                        <span>Test only (visible to admins, not regular users)</span>
                    </label>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit">Save changes</button>
                    </div>
                </div>
            `);

            const titleInput = dialog.querySelector(".release-note-title");
            const dateInput = dialog.querySelector(".release-note-date");
            const contentInput = dialog.querySelector(".release-note-content");
            const testInput = dialog.querySelector(".release-note-test");
            const errorElement = dialog.querySelector('[data-role="error"]');

            titleInput.value = note.title || "";
            dateInput.value = releaseDateValue;
            contentInput.value = note.contentHtml || "";
            testInput.checked = note.test === true;

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            dialog.querySelector(".admin-panel-add-submit").addEventListener("click", async () =>
            {
                const title = titleInput.value.trim();
                if (title.length === 0)
                {
                    errorElement.textContent = "Title is required.";
                    errorElement.hidden = false;
                    return;
                }

                const updates = { title, contentHtml: contentInput.value, test: testInput.checked };
                if (dateInput.value)
                {
                    updates.releaseDate = new Date(dateInput.value).toISOString();
                }

                errorElement.hidden = true;
                const response = await fetch("/Admin/ReleaseNotes/Update",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: note.id, updates })
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

            titleInput.focus();
        });
    }

    async #handleDeleteReleaseNote(note)
    {
        const confirmed = await DialogBox.confirm(
            "Delete release note",
            `Delete release note ${note.version} — "${note.title}"? This cannot be undone.`
        );
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Admin/ReleaseNotes/Delete",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: note.id })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Could not delete", responseJson.error || `HTTP ${response.status}`);
            return;
        }

        await this.#renderTab();
    }

    async #renderOrganizationsTab(content)
    {
        content.innerHTML = `<div class="admin-panel-loading">Loading organizations…</div>`;

        let organizations;
        try
        {
            const response = await fetch("/Admin/Organizations/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }
            const responseJson = await response.json();
            organizations = Array.isArray(responseJson.organizations) ? responseJson.organizations : [];
        }
        catch (loadError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(loadError.message)}</div>`;
            return;
        }

        this.#organizations = organizations;

        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="create-organization">Create organization</button>
            </div>
            <table class="admin-panel-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Admin email</th>
                        <th>Status</th>
                        <th>Members</th>
                        <th>Created</th>
                        <th>Perks</th>
                        <th>Last payment</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody data-role="organization-rows"></tbody>
            </table>
            <p class="admin-panel-pricing-note">
                Creating an organization sends an email-OTP to the appointed admin —
                share the code with them, type it back here, then take payment via
                Razorpay (or set the amount to 0 to skip payment). Organizations stay
                in PENDING_PAYMENT until Razorpay confirms; the webhook handles
                close-tab-mid-checkout automatically.
            </p>
        `;

        this.querySelector('[data-role="create-organization"]').addEventListener("click", async () =>
        {
            const created = await CreateOrganizationDialog.show();
            if (created)
            {
                await this.#renderTab();
            }
        });

        this.#renderOrganizationRows(organizations);
    }

    #renderOrganizationRows(organizations)
    {
        const tbody = this.querySelector('[data-role="organization-rows"]');
        if (!tbody)
        {
            return;
        }

        if (organizations.length === 0)
        {
            tbody.innerHTML = `<tr><td colspan="8" class="admin-panel-loading">No organizations yet.</td></tr>`;
            return;
        }

        const statusLabel = (statusValue) =>
        {
            if (statusValue === organizationStatus.PENDING_PAYMENT) return "Pending payment";
            if (statusValue === organizationStatus.ACTIVE) return "Active";
            if (statusValue === organizationStatus.SUSPENDED) return "Suspended";
            return String(statusValue);
        };
        const formatDate = (value) =>
        {
            if (!value) return "";
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
        };

        tbody.innerHTML = organizations.map((organization) =>
        {
            return `
                <tr data-organization-id="${AdminPanelPage.#escape(organization.id)}">
                    <td>${AdminPanelPage.#escape(organization.name)}</td>
                    <td>${AdminPanelPage.#escape(organization.adminEmail)}</td>
                    <td>${AdminPanelPage.#escape(statusLabel(organization.status))}</td>
                    <td>${organization.currentMemberCount} / ${organization.maxMembers}</td>
                    <td>${AdminPanelPage.#escape(formatDate(organization.creationDate))}</td>
                    <td>${organization.perkCount}</td>
                    <td>${organization.lastPaymentStatus !== null && organization.lastPaymentStatus !== undefined ? organization.lastPaymentStatus : ""}</td>
                    <td>
                        <button data-action="view-organization" data-organization-id="${AdminPanelPage.#escape(organization.id)}">View / edit</button>
                        <button data-action="delete-organization" data-organization-id="${AdminPanelPage.#escape(organization.id)}">Delete</button>
                    </td>
                </tr>
            `;
        }).join("");

        for (const viewButton of this.querySelectorAll('[data-action="view-organization"]'))
        {
            viewButton.addEventListener("click", async (clickEvent) =>
            {
                const organizationId = clickEvent.currentTarget.dataset.organizationId;
                const refreshed = await OrganizationDetailsDialog.show(organizationId);
                if (refreshed)
                {
                    await this.#renderTab();
                }
            });
        }

        for (const deleteButton of this.querySelectorAll('[data-action="delete-organization"]'))
        {
            deleteButton.addEventListener("click", async (clickEvent) =>
            {
                const organizationId = clickEvent.currentTarget.dataset.organizationId;
                const organization = organizations.find(entry => entry.id === organizationId);
                if (!organization) return;
                await this.#handleDeleteOrganization(organization);
            });
        }
    }

    async #handleDeleteOrganization(organization)
    {
        const confirmed = await DialogBox.confirm
        (
            "Delete organization",
            `Delete "${organization.name}"? This removes members and perks immediately. Already-issued deck licenses remain valid until their own expiry. This cannot be undone.`
        );
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Admin/Organizations/Delete",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId: organization.id })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Could not delete", responseJson.error || `HTTP ${response.status}`);
            return;
        }

        await this.#renderTab();
    }

    async #renderOrganizationMembersTab(content)
    {
        content.innerHTML = `<div class="admin-panel-loading">Loading organizations…</div>`;

        let organizations;
        try
        {
            const response = await fetch("/Organization/Mine/List");
            if (!response.ok)
            {
                content.innerHTML = `<div class="admin-panel-error">HTTP ${response.status}</div>`;
                return;
            }
            const responseJson = await response.json();
            organizations = Array.isArray(responseJson.organizations) ? responseJson.organizations : [];
        }
        catch (loadError)
        {
            content.innerHTML = `<div class="admin-panel-error">${AdminPanelPage.#escape(loadError.message)}</div>`;
            return;
        }

        const activeOrganizations = organizations.filter(organization => organization.status === organizationStatus.ACTIVE);

        if (activeOrganizations.length === 0)
        {
            content.innerHTML = `
                <p>You don't currently administer any active organizations.</p>
                <p class="admin-panel-pricing-note">
                    If an organization is awaiting payment, the MindMeld team
                    will activate it after payment clears — members can be
                    added at that point.
                </p>
            `;
            return;
        }

        // Default the picker to the first active org on initial render
        // and persist the selection across re-renders so adding a member
        // doesn't snap the user back to the first org.
        if (!this.#selectedMemberOrganizationId || !activeOrganizations.some(organization => organization.id === this.#selectedMemberOrganizationId))
        {
            this.#selectedMemberOrganizationId = activeOrganizations[0].id;
        }

        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <label>
                    Organization:
                    <select class="admin-panel-org-picker">
                        ${activeOrganizations.map(organization => `<option value="${AdminPanelPage.#escape(organization.id)}" ${organization.id === this.#selectedMemberOrganizationId ? "selected" : ""}>${AdminPanelPage.#escape(organization.name)}</option>`).join("")}
                    </select>
                </label>
                <button class="admin-panel-upload" data-role="add-members">Add members</button>
                <button class="admin-panel-bulk-apply" data-role="bulk-remove" disabled>Remove selected (0)</button>
                <span class="admin-panel-member-counts" data-role="member-counts"></span>
            </div>
            <table class="admin-panel-table">
                <thead>
                    <tr>
                        <th><input type="checkbox" class="admin-panel-select-all-members"></th>
                        <th>Email</th>
                        <th>User</th>
                        <th>Added</th>
                    </tr>
                </thead>
                <tbody data-role="member-rows"></tbody>
            </table>
        `;

        const picker = this.querySelector(".admin-panel-org-picker");
        picker.addEventListener("change", async () =>
        {
            this.#selectedMemberOrganizationId = picker.value;
            this.#selectedMemberIds.clear();
            await this.#loadOrganizationMembers();
        });

        this.querySelector('[data-role="add-members"]').addEventListener("click", async () =>
        {
            const added = await AddMembersDialog.show
            ({
                organizationId: this.#selectedMemberOrganizationId,
                existingMembers: this.#organizationMembers
            });
            if (added)
            {
                await this.#loadOrganizationMembers();
            }
        });

        this.querySelector('[data-role="bulk-remove"]').addEventListener("click", () => this.#handleBulkRemoveMembers());

        const selectAllCheckbox = this.querySelector(".admin-panel-select-all-members");
        selectAllCheckbox.addEventListener("change", () =>
        {
            if (selectAllCheckbox.checked)
            {
                for (const member of this.#organizationMembers)
                {
                    this.#selectedMemberIds.add(member.id);
                }
            }
            else
            {
                this.#selectedMemberIds.clear();
            }
            this.#renderMemberRows();
        });

        await this.#loadOrganizationMembers();
    }

    async #loadOrganizationMembers()
    {
        const queryUrl = `/Organization/Members/List?organizationId=${encodeURIComponent(this.#selectedMemberOrganizationId)}`;
        let payload;
        try
        {
            const response = await fetch(queryUrl);
            if (!response.ok)
            {
                this.#organizationMembers = [];
                this.#renderMemberRows();
                this.#updateMemberCounts(0, 0);
                return;
            }
            payload = await response.json();
        }
        catch (loadError)
        {
            this.#organizationMembers = [];
            this.#renderMemberRows();
            this.#updateMemberCounts(0, 0);
            return;
        }

        this.#organizationMembers = Array.isArray(payload?.members) ? payload.members : [];
        this.#updateMemberCounts(payload?.currentMemberCount || 0, payload?.maxMembers || 0);
        this.#renderMemberRows();
    }

    #updateMemberCounts(current, max)
    {
        const counts = this.querySelector('[data-role="member-counts"]');
        if (!counts)
        {
            return;
        }
        const remainingSlots = Math.max(0, max - current);
        if (remainingSlots === 0)
        {
            counts.innerHTML = `<strong>${current} / ${max}</strong> — capacity reached. Contact MindMeld to extend.`;
        }
        else
        {
            counts.innerHTML = `<strong>${current} / ${max}</strong> members (${remainingSlots} slot${remainingSlots === 1 ? "" : "s"} remaining)`;
        }
    }

    #renderMemberRows()
    {
        const tbody = this.querySelector('[data-role="member-rows"]');
        if (!tbody)
        {
            return;
        }

        if (this.#organizationMembers.length === 0)
        {
            tbody.innerHTML = `<tr><td colspan="4" class="admin-panel-loading">No members yet. Use “Add members” to invite emails to this organization.</td></tr>`;
            this.#refreshBulkRemoveButton();
            return;
        }

        const formatDate = (value) =>
        {
            if (!value) return "";
            const parsed = new Date(value);
            return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();
        };

        tbody.innerHTML = this.#organizationMembers.map((member) =>
        {
            const isSelected = this.#selectedMemberIds.has(member.id);
            const userBadge = member.userId && member.userId.length > 0 ? "Account linked" : "Pending first login";
            return `
                <tr data-member-id="${AdminPanelPage.#escape(member.id)}">
                    <td><input type="checkbox" class="admin-panel-member-select" data-member-id="${AdminPanelPage.#escape(member.id)}" ${isSelected ? "checked" : ""}></td>
                    <td>${AdminPanelPage.#escape(member.email)}</td>
                    <td>${AdminPanelPage.#escape(userBadge)}</td>
                    <td>${AdminPanelPage.#escape(formatDate(member.addedAt))}</td>
                </tr>
            `;
        }).join("");

        for (const checkbox of this.querySelectorAll(".admin-panel-member-select"))
        {
            checkbox.addEventListener("change", () =>
            {
                const memberId = checkbox.dataset.memberId;
                if (checkbox.checked)
                {
                    this.#selectedMemberIds.add(memberId);
                }
                else
                {
                    this.#selectedMemberIds.delete(memberId);
                }
                this.#refreshBulkRemoveButton();
            });
        }

        this.#refreshBulkRemoveButton();
    }

    #refreshBulkRemoveButton()
    {
        const button = this.querySelector('[data-role="bulk-remove"]');
        if (!button)
        {
            return;
        }
        const count = this.#selectedMemberIds.size;
        button.disabled = count === 0;
        button.textContent = `Remove selected (${count})`;
    }

    async #handleBulkRemoveMembers()
    {
        const ids = Array.from(this.#selectedMemberIds);
        if (ids.length === 0)
        {
            return;
        }
        const confirmed = await DialogBox.confirm
        (
            "Remove members",
            `Remove ${ids.length} member${ids.length === 1 ? "" : "s"} from this organization? Their existing deck licenses are not revoked — they keep access until each license's own expiry.`
        );
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Organization/Members/BulkRemove",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ organizationId: this.#selectedMemberOrganizationId, memberIds: ids })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Could not remove", responseJson.error || `HTTP ${response.status}`);
            return;
        }
        const responseJson = await response.json();
        const summary = responseJson.summary || { requested: ids.length, removed: 0, notFound: 0 };

        this.#selectedMemberIds.clear();
        await DialogBox.alert("Members removed", `Removed ${summary.removed} of ${summary.requested}${summary.notFound > 0 ? ` (${summary.notFound} not found)` : ""}.`);
        await this.#loadOrganizationMembers();
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
