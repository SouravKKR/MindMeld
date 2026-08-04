import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import DialogBox from "../../CommonComponents/DialogBox.js";
import AdminListView from "../../CommonComponents/AdminListView.js";
import PaidDeckUploadDialog from "./Components/PaidDeckUploadDialog.js";
import PaidDeckEditDialog from "./Components/PaidDeckEditDialog.js";
import BulkApplyDialog from "./Components/BulkApplyDialog.js";
import PaidDeckShareQrDialog from "./Components/PaidDeckShareQrDialog.js";
import CreateOrganizationDialog from "./Components/CreateOrganizationDialog.js";
import OrganizationDetailsDialog from "./Components/OrganizationDetailsDialog.js";
import AddMembersDialog from "./Components/AddMembersDialog.js";
import AlertNotifier from "./Components/AlertNotifier.js";
import AdminCreditsTabs from "./Components/AdminCreditsTabs.js";
import SetUserStreakPanel from "./Components/SetUserStreakPanel.js";
import AdminLogsPanel from "./Components/AdminLogsPanel.js";
import CouponsPanel from "./Components/CouponsPanel.js";
import PlanFeaturesPanel from "./Components/PlanFeaturesPanel.js";
import SupportTicketDetailsDialog from "./Components/SupportTicketDetailsDialog.js";
import { userRoles } from "../../Globals/Enumerations/UserRoles.js";
import { adminPanelTabs } from "../../Globals/Enumerations/AdminPanelTabs.js";
import { adminListTypes } from "../../Globals/Enumerations/AdminListTypes.js";
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
    // The AdminListView currently mounted in the active tab, so row/bulk action
    // handlers can refresh the page after a mutation without re-rendering the
    // whole tab.
    #currentListView = null;
    #selectedMemberOrganizationId = "";
    #organizationMembers = [];

    /**
     * Builds a configured AdminListView, remembers it as the current list, and
     * returns it ready to append. Every retrofitted tab funnels through here so
     * the action handlers share one refresh path.
     */
    #createListView(config)
    {
        const listView = document.createElement("admin-list-view");
        listView.configure(config);
        this.#currentListView = listView;
        return listView;
    }

    #refreshCurrentList()
    {
        if (this.#currentListView)
        {
            this.#currentListView.refresh();
        }
    }

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
            { tab: adminPanelTabs.ALLOWED_EMAILS, label: "Access" },
            { tab: adminPanelTabs.RELEASE_NOTES, label: "Release Notes" },
            { tab: adminPanelTabs.ORGANIZATIONS, label: "Organizations" },
            { tab: adminPanelTabs.ALERTS, label: "Alerts" },
            { tab: adminPanelTabs.RATE_LIMITS, label: "Rate Limits" },
            { tab: adminPanelTabs.AUDIT_LOG, label: "Audit Log" },
            { tab: adminPanelTabs.CREDITS, label: "Credits" },
            { tab: adminPanelTabs.SUBSCRIPTIONS, label: "Plans" },
            { tab: adminPanelTabs.COUPONS, label: "Coupons" },
            { tab: adminPanelTabs.MAINTENANCE, label: "Maintenance" },
            { tab: adminPanelTabs.STREAKS, label: "Streaks" },
            { tab: adminPanelTabs.LOGS, label: "Logs" },
            { tab: adminPanelTabs.SUPPORT_TICKETS, label: "Support" }
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
            ? new Set([adminPanelTabs.DECKS, adminPanelTabs.STATS, adminPanelTabs.ADMINS, adminPanelTabs.ALLOWED_EMAILS, adminPanelTabs.RELEASE_NOTES, adminPanelTabs.ORGANIZATIONS, adminPanelTabs.ALERTS, adminPanelTabs.RATE_LIMITS, adminPanelTabs.AUDIT_LOG, adminPanelTabs.CREDITS, adminPanelTabs.SUBSCRIPTIONS, adminPanelTabs.COUPONS, adminPanelTabs.MAINTENANCE, adminPanelTabs.STREAKS, adminPanelTabs.LOGS, adminPanelTabs.SUPPORT_TICKETS])
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
            case adminPanelTabs.ALLOWED_EMAILS:
                await this.#renderAllowedEmailsTab(content);
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
            case adminPanelTabs.SUBSCRIPTIONS:
                this.#renderSubscriptionsTab(content);
                break;
            case adminPanelTabs.COUPONS:
                this.#renderCouponsTab(content);
                break;
            case adminPanelTabs.MAINTENANCE:
                await this.#renderMaintenanceTab(content);
                break;
            case adminPanelTabs.STREAKS:
                this.#renderStreaksTab(content);
                break;
            case adminPanelTabs.LOGS:
                this.#renderLogsTab(content);
                break;
            case adminPanelTabs.SUPPORT_TICKETS:
                this.#renderSupportTicketsTab(content);
                break;
            case adminPanelTabs.ORGANIZATION_MEMBERS:
                await this.#renderOrganizationMembersTab(content);
                break;
        }
    }

    #renderStreaksTab(content)
    {
        // Admin testing tool to set / reset any user's login streak.
        content.innerHTML = "";
        content.appendChild(document.createElement("set-user-streak-panel"));
    }

    #renderLogsTab(content)
    {
        // Colour-coded log console with history, live tail, download (.log/.html,
        // optional split) and the settable archival interval. AdminLogsPanel owns
        // its own data fetching against /Admin/Lists/Query and /Admin/Logs/*.
        content.innerHTML = "";
        content.appendChild(document.createElement("admin-logs-panel"));
    }

    #renderCreditsTab(content)
    {
        // One sub-tabbed surface hosting the grant panel and the sectioned
        // credit-config editor (pricing & packs, task rules, storage rules,
        // milestones & global). AdminCreditsTabs keeps both panels mounted
        // across sub-tab switches so unsaved edits survive.
        content.innerHTML = "";
        content.appendChild(document.createElement("admin-credits-tabs"));
    }

    #renderSubscriptionsTab(content)
    {
        // The plan tier × AI-feature access matrix (which plan unlocks what).
        content.innerHTML = "";
        content.appendChild(document.createElement("plan-features-panel"));
    }

    #renderCouponsTab(content)
    {
        content.innerHTML = "";
        content.appendChild(document.createElement("coupons-panel"));
    }

    // ── Scheduled maintenance windows ──────────────────────────────────────

    static #toDatetimeLocalValue(isoString)
    {
        if (!isoString)
        {
            return "";
        }
        const date = new Date(isoString);
        if (Number.isNaN(date.getTime()))
        {
            return "";
        }
        // Build a local "YYYY-MM-DDTHH:mm" string for the datetime-local input.
        const pad = (value) => String(value).padStart(2, "0");
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    #renderMaintenanceTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-maintenance-window">Add maintenance window</button>
            </div>
            <div data-role="list-host"></div>
        `;

        this.querySelector('[data-role="add-maintenance-window"]').addEventListener("click", async () =>
        {
            const created = await this.#openCreateMaintenanceWindowDialog();
            if (created)
            {
                this.#refreshCurrentList();
            }
        });

        const listView = this.#createListView
        ({
            listKey: adminListTypes.MAINTENANCE_WINDOWS,
            rowActions:
            [
                { actionKey: "edit", label: "Edit" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: async (actionKey, rowId, row) =>
            {
                if (actionKey === "edit")
                {
                    const updated = await this.#openEditMaintenanceWindowDialog(row);
                    if (updated)
                    {
                        this.#refreshCurrentList();
                    }
                }
                else if (actionKey === "delete")
                {
                    await this.#handleDeleteMaintenanceWindow(row);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
    }

    async #openCreateMaintenanceWindowDialog()
    {
        return this.#openMaintenanceWindowDialog(null);
    }

    async #openEditMaintenanceWindowDialog(window)
    {
        return this.#openMaintenanceWindowDialog(window);
    }

    async #openMaintenanceWindowDialog(existingWindow)
    {
        const isEdit = existingWindow !== null;
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal(`
                <div class="admin-panel-add-dialog">
                    <h2 class="admin-panel-add-title">${isEdit ? "Edit" : "Add"} maintenance window</h2>
                    <label class="admin-panel-add-field">
                        <span>Title</span>
                        <input type="text" class="maintenance-window-title" maxlength="256">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Start</span>
                        <input type="datetime-local" class="maintenance-window-start">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>End</span>
                        <input type="datetime-local" class="maintenance-window-end">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Message to users (optional)</span>
                        <textarea class="maintenance-window-message" rows="3" maxlength="2000"></textarea>
                    </label>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit">${isEdit ? "Save changes" : "Schedule"}</button>
                    </div>
                </div>
            `);

            const titleInput = dialog.querySelector(".maintenance-window-title");
            const startInput = dialog.querySelector(".maintenance-window-start");
            const endInput = dialog.querySelector(".maintenance-window-end");
            const messageInput = dialog.querySelector(".maintenance-window-message");
            const errorElement = dialog.querySelector('[data-role="error"]');

            if (isEdit)
            {
                titleInput.value = existingWindow.title || "";
                startInput.value = AdminPanelPage.#toDatetimeLocalValue(existingWindow.startDate);
                endInput.value = AdminPanelPage.#toDatetimeLocalValue(existingWindow.endDate);
                messageInput.value = existingWindow.message || "";
            }

            dialog.querySelector(".admin-panel-add-cancel").addEventListener("click", () =>
            {
                dialog.close();
                resolve(false);
            });

            dialog.querySelector(".admin-panel-add-submit").addEventListener("click", async () =>
            {
                if (!startInput.value || !endInput.value)
                {
                    errorElement.textContent = "Start and end are both required.";
                    errorElement.hidden = false;
                    return;
                }

                const startDate = new Date(startInput.value);
                const endDate = new Date(endInput.value);
                if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate.getTime() <= startDate.getTime())
                {
                    errorElement.textContent = "End must be after start.";
                    errorElement.hidden = false;
                    return;
                }

                errorElement.hidden = true;

                let response;
                if (isEdit)
                {
                    response = await fetch("/Admin/Maintenance/Update",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "same-origin",
                        body: JSON.stringify({
                            id: existingWindow.id,
                            updates: {
                                title: titleInput.value.trim() || "Scheduled maintenance",
                                startDate: startDate.toISOString(),
                                endDate: endDate.toISOString(),
                                message: messageInput.value
                            }
                        })
                    });
                }
                else
                {
                    response = await fetch("/Admin/Maintenance/Add",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "same-origin",
                        body: JSON.stringify({
                            title: titleInput.value.trim() || "Scheduled maintenance",
                            startDate: startDate.toISOString(),
                            endDate: endDate.toISOString(),
                            message: messageInput.value
                        })
                    });
                }

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

    async #handleDeleteMaintenanceWindow(window)
    {
        const confirmed = await DialogBox.confirm(
            "Delete maintenance window",
            `Delete the maintenance window "${window.title}"? This cannot be undone.`
        );
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Admin/Maintenance/Remove",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ id: window.id })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            await DialogBox.alert("Could not delete", responseJson.error || `HTTP ${response.status}`);
            return;
        }

        this.#refreshCurrentList();
    }

    #renderDecksTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload">Upload new deck</button>
            </div>
            <div data-role="list-host"></div>
        `;

        this.querySelector(".admin-panel-upload").addEventListener("click", () => this.#openUploadDialog());

        const listView = this.#createListView
        ({
            listKey: adminListTypes.PAID_DECKS,
            selectable: true,
            bulkActions: [ { actionKey: "bulkApply", label: "Apply to selected" } ],
            rowActions: (row) =>
            {
                const subdeckCount = Array.isArray(row.bundleChildIds) ? row.bundleChildIds.length : 0;
                const actions =
                [
                    { actionKey: "edit", label: "Edit" },
                    { actionKey: "publish", label: row.isPublished ? "Unpublish" : "Publish" },
                    { actionKey: "rotate", label: "Rotate key" },
                    // Offered on every deck. A deck the generation pipeline did
                    // not produce has no provenance record, and the handler says
                    // so plainly rather than the option being hidden — "there is
                    // no record" is the useful answer, not a missing button.
                    { actionKey: "auditTrail", label: "Download Audit Trail" },
                    // Offered on unpublished decks too. The panel says the link
                    // will not open yet rather than the action being hidden —
                    // an admin about to print a poster needs telling, not
                    // leaving to guess why the button is missing.
                    { actionKey: "shareQrCode", label: "Share QR code" }
                ];
                if (subdeckCount > 0)
                {
                    actions.push({ actionKey: "apply-to-subdecks", label: "Apply to subdecks" });
                }
                return actions;
            },
            onRowAction: (actionKey, rowId, row) => this.#handleDeckRowAction(actionKey, row),
            onBulkAction: async (actionKey, selectedIds) =>
            {
                if (actionKey === "bulkApply")
                {
                    await this.#openBulkApplyForSelection(selectedIds);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
    }

    /**
     * Downloads the generation audit trail PDF for one paid deck.
     *
     * The server renders the report strictly from the stored provenance record,
     * so this is a plain download — there is deliberately no filter, date range
     * or section selection to pass. An audit trail the requester can narrow is
     * not one.
     */
    async #downloadAuditTrail(deck)
    {
        try
        {
            const response = await fetch(`/Admin/PaidDecks/AuditTrail?deckId=${encodeURIComponent(deck.id)}`);

            if (response.status === 404)
            {
                await DialogBox.alert(
                    "No audit trail for this deck",
                    "This deck has no generation-provenance record, which means it was not produced by the "
                    + "paid-deck generation pipeline. There is no audit trail to download.",
                );
                return;
            }

            if (!response.ok)
            {
                const failure = await response.json().catch(() => ({}));
                await DialogBox.alert("Couldn't build the audit trail", failure.detail || "The report could not be rendered.");
                return;
            }

            const pdfBlob = await response.blob();
            const objectUrl = URL.createObjectURL(pdfBlob);
            const downloadLink = document.createElement("a");
            downloadLink.href = objectUrl;
            downloadLink.download = `CogniumLearn-AuditTrail-${(deck.title || deck.id).replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`;
            document.body.appendChild(downloadLink);
            downloadLink.click();
            downloadLink.remove();
            URL.revokeObjectURL(objectUrl);
        }
        catch (downloadError)
        {
            await DialogBox.alert("Couldn't build the audit trail", downloadError.message);
        }
    }

    async #handleDeckRowAction(action, deck)
    {
        if (!deck) return;

        switch (action)
        {
            case "edit":
            {
                const saved = await PaidDeckEditDialog.show(deck);
                if (saved) this.#refreshCurrentList();
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
            case "auditTrail":
            {
                await this.#downloadAuditTrail(deck);
                break;
            }
            case "shareQrCode":
            {
                await PaidDeckShareQrDialog.show(deck);
                break;
            }
            case "apply-to-subdecks":
            {
                const applied = await BulkApplyDialog.show
                ({
                    title: `Apply to subdecks of ${deck.title}`,
                    deckIds: Array.isArray(deck.bundleChildIds) ? deck.bundleChildIds : []
                });
                if (applied) this.#refreshCurrentList();
                break;
            }
        }
    }

    async #openUploadDialog()
    {
        const uploaded = await PaidDeckUploadDialog.show();
        if (uploaded) this.#refreshCurrentList();
    }

    async #openBulkApplyForSelection(deckIds)
    {
        const applied = await BulkApplyDialog.show
        ({
            title: `Apply to ${deckIds.length} selected deck${deckIds.length === 1 ? "" : "s"}`,
            deckIds: deckIds
        });
        if (applied)
        {
            if (this.#currentListView)
            {
                this.#currentListView.clearSelection();
            }
            this.#refreshCurrentList();
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
        this.#refreshCurrentList();
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
            this.#refreshCurrentList();
        }
        else
        {
            await DialogBox.alert("Update failed", `HTTP ${response.status}`);
        }
    }

    #renderAlertsTab(content)
    {
        // Visiting the tab is a good moment to make sure the background
        // notifier is running for this admin session.
        AlertNotifier.start();

        content.innerHTML = `
            <div class="admin-panel-alerts-toolbar">
                <button class="admin-panel-alerts-notify" data-role="enable-notifications"></button>
                <span class="admin-panel-alerts-notify-state" data-role="notify-state"></span>
            </div>
            <div data-role="list-host"></div>
        `;

        this.#refreshNotifyButton();
        this.querySelector('[data-role="enable-notifications"]').addEventListener("click", async () =>
        {
            await AlertNotifier.requestPermission();
            AlertNotifier.start();
            this.#refreshNotifyButton();
        });

        // First visit and no decision yet — prompt once.
        if (AlertNotifier.getPermission() === "default")
        {
            AlertNotifier.requestPermission().then(() => this.#refreshNotifyButton());
        }

        const listView = this.#createListView
        ({
            listKey: adminListTypes.ALERTS,
            rowActions:
            [
                { actionKey: "acknowledge", label: "Acknowledge" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: async (actionKey, rowId) =>
            {
                if (actionKey === "acknowledge")
                {
                    await this.#postAlertAction("/Admin/Alerts/Acknowledge", rowId);
                }
                else if (actionKey === "delete")
                {
                    await this.#postAlertAction("/Admin/Alerts/Delete", rowId);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
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
            this.#refreshCurrentList();
        }
        else
        {
            await DialogBox.alert("Failed", `HTTP ${response.status}`);
        }
    }

    #renderRateLimitsTab(content)
    {
        content.innerHTML = `<div data-role="list-host"></div>`;
        this.querySelector('[data-role="list-host"]').appendChild
        (
            this.#createListView({ listKey: adminListTypes.RATE_LIMIT_EVENTS })
        );
    }

    #renderSupportTicketsTab(content)
    {
        // Reports are deduplicated into tickets server-side, so a row here is a
        // distinct problem and its Reporters column is how many people hit it. The
        // list defaults to sorting by that count, which puts the issue worth fixing
        // first at the top.
        content.innerHTML = `
            <p class="admin-panel-stats-note">
                Reports describing the same problem are grouped into one ticket. Open a ticket to read every
                report, download the reporter's logs, and resolve or decline it.
            </p>
            <div data-role="list-host"></div>
            <p class="admin-panel-stats-note admin-panel-support-ungrouped-note">
                Reports that never reached a ticket — the deduplication task failed or could not run. They are
                stored and visible to their reporter, but no resolution will ever reach them until they are
                grouped, so this list should normally be empty.
            </p>
            <div data-role="ungrouped-list-host"></div>
        `;

        this.querySelector('[data-role="list-host"]').appendChild
        (
            this.#createListView
            ({
                listKey: adminListTypes.SUPPORT_TICKETS,
                rowActions: [ { actionKey: "open", label: "Open" } ],
                onRowAction: async (actionKey, rowId) =>
                {
                    if (actionKey !== "open")
                    {
                        return;
                    }

                    const bChanged = await SupportTicketDetailsDialog.show({ ticketId: rowId });

                    if (bChanged)
                    {
                        this.#refreshCurrentList();
                    }
                }
            })
        );

        // Appended directly rather than through #createListView so it does not
        // steal #currentListView from the tickets table above — the row action
        // there refreshes whichever list that field points at.
        const ungroupedListView = document.createElement("admin-list-view");
        ungroupedListView.configure({ listKey: adminListTypes.SUPPORT_UNGROUPED_REPORTS });
        this.querySelector('[data-role="ungrouped-list-host"]').appendChild(ungroupedListView);
    }

    #renderAuditLogTab(content)
    {
        content.innerHTML = `<div data-role="list-host"></div>`;
        this.querySelector('[data-role="list-host"]').appendChild
        (
            this.#createListView({ listKey: adminListTypes.ADMIN_AUDIT_EVENTS })
        );
    }

    #renderStatsTab(content)
    {
        content.innerHTML = `
            <p>Revenue by deck</p>
            <div data-role="list-host"></div>
            <p class="admin-panel-stats-note">
                Once the PricingOptimizer ships, this aggregation will feed its
                region-aware margin model directly.
            </p>
        `;
        this.querySelector('[data-role="list-host"]').appendChild
        (
            this.#createListView({ listKey: adminListTypes.REVENUE_BY_DECK, rowIdField: "deckId" })
        );
    }

    #renderAdminsTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-admin">Add admin</button>
            </div>
            <div data-role="list-host"></div>
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
                this.#refreshCurrentList();
            }
        });

        const listView = this.#createListView
        ({
            listKey: adminListTypes.ADMIN_EMAILS,
            rowActions: [ { actionKey: "remove", label: "Remove" } ],
            onRowAction: (actionKey, rowId) =>
            {
                if (actionKey === "remove")
                {
                    this.#handleRemoveAdmin(rowId);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
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

        this.#refreshCurrentList();
    }

    #renderAllowedEmailsTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-allowed-email">Add allowed email</button>
            </div>
            <div data-role="list-host"></div>
            <p class="admin-panel-pricing-note">
                When the per-environment login allowlist is enabled (dev / test only),
                only emails on this list — plus the env allowlist and every admin email —
                may sign in. In production the allowlist is disabled and everyone can log
                in as normal. Being on this list only permits login; it never grants the
                ADMIN role. Emptying the list is safe — it just leaves the env / admin
                emails allowed.
            </p>
        `;

        this.querySelector('[data-role="add-allowed-email"]').addEventListener("click", async () =>
        {
            const added = await this.#openAddAllowedEmailDialog();
            if (added)
            {
                this.#refreshCurrentList();
            }
        });

        const listView = this.#createListView
        ({
            listKey: adminListTypes.ALLOWED_LOGIN_EMAILS,
            rowActions: [ { actionKey: "remove", label: "Remove" } ],
            onRowAction: (actionKey, rowId) =>
            {
                if (actionKey === "remove")
                {
                    this.#handleRemoveAllowedEmail(rowId);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
    }

    async #openAddAllowedEmailDialog()
    {
        return new Promise((resolve) =>
        {
            const dialog = DialogBox.modal
            (`
                <div class="admin-panel-add-dialog">
                    <h2 class="admin-panel-add-title">Add allowed email</h2>
                    <p class="admin-panel-add-subtitle">
                        This email will be permitted to log in when the environment
                        allowlist is enabled. It does not grant admin access.
                    </p>
                    <label class="admin-panel-add-field">
                        <span>Email</span>
                        <input type="email" class="admin-panel-add-email" placeholder="name@example.com" autocomplete="off">
                    </label>
                    <label class="admin-panel-add-field">
                        <span>Notes (optional)</span>
                        <textarea class="admin-panel-add-notes" rows="3" placeholder="Why this person needs access"></textarea>
                    </label>
                    <div class="admin-panel-add-error" data-role="error" hidden></div>
                    <div class="admin-panel-add-actions">
                        <button type="button" class="admin-panel-add-cancel">Cancel</button>
                        <button type="button" class="admin-panel-add-submit">Add allowed email</button>
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
                const response = await fetch("/Admin/AllowedEmails/Add",
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

    async #handleRemoveAllowedEmail(targetEmail)
    {
        if (!targetEmail)
        {
            return;
        }
        const confirmed = await DialogBox.confirm("Remove allowed email", `Remove ${targetEmail} from the login allowlist?`);
        if (!confirmed)
        {
            return;
        }

        const response = await fetch("/Admin/AllowedEmails/Remove",
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

        this.#refreshCurrentList();
    }

    #renderReleaseNotesTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="add-release-note">Add release note</button>
            </div>
            <div data-role="list-host"></div>
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
                this.#refreshCurrentList();
            }
        });

        const listView = this.#createListView
        ({
            listKey: adminListTypes.RELEASE_NOTES,
            rowActions:
            [
                { actionKey: "edit", label: "Edit" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: async (actionKey, rowId, row) =>
            {
                if (actionKey === "edit")
                {
                    const updated = await this.#openEditReleaseNoteDialog(row);
                    if (updated)
                    {
                        this.#refreshCurrentList();
                    }
                }
                else if (actionKey === "delete")
                {
                    await this.#handleDeleteReleaseNote(row);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
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

        this.#refreshCurrentList();
    }

    #renderOrganizationsTab(content)
    {
        content.innerHTML = `
            <div class="admin-panel-toolbar">
                <button class="admin-panel-upload" data-role="create-organization">Create organization</button>
            </div>
            <div data-role="list-host"></div>
            <p class="admin-panel-pricing-note">
                Creating an organization sends an email-OTP to the appointed admin —
                share the code with them, type it back here, then take payment via
                Zoho Payments (or set the amount to 0 to skip payment). Organizations
                stay in PENDING_PAYMENT until the payment confirms; the webhook handles
                close-tab-mid-checkout automatically.
            </p>
        `;

        this.querySelector('[data-role="create-organization"]').addEventListener("click", async () =>
        {
            const created = await CreateOrganizationDialog.show();
            if (created)
            {
                this.#refreshCurrentList();
            }
        });

        const listView = this.#createListView
        ({
            listKey: adminListTypes.ORGANIZATIONS,
            rowActions:
            [
                { actionKey: "view", label: "View / edit" },
                { actionKey: "delete", label: "Delete" }
            ],
            onRowAction: async (actionKey, rowId, row) =>
            {
                if (actionKey === "view")
                {
                    const refreshed = await OrganizationDetailsDialog.show(rowId);
                    if (refreshed)
                    {
                        this.#refreshCurrentList();
                    }
                }
                else if (actionKey === "delete")
                {
                    await this.#handleDeleteOrganization(row);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
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

        this.#refreshCurrentList();
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
                    If an organization is awaiting payment, the CogniumLearn team
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
                <span class="admin-panel-member-counts" data-role="member-counts"></span>
            </div>
            <div data-role="list-host"></div>
        `;

        const picker = this.querySelector(".admin-panel-org-picker");
        picker.addEventListener("change", () =>
        {
            this.#selectedMemberOrganizationId = picker.value;
            if (this.#currentListView)
            {
                this.#currentListView.setRequestContext({ organizationId: this.#selectedMemberOrganizationId });
            }
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
                this.#refreshCurrentList();
            }
        });

        // Members live behind an org-admin-scoped endpoint, not the super-admin
        // /Admin/Lists/* surface, so the list view drives its own fetch via a
        // customFetcher and slices/searches the result client-side.
        const listView = this.#createListView
        ({
            searchEnabled: true,
            searchPlaceholder: "Search email…",
            selectable: true,
            bulkActions: [ { actionKey: "bulkRemove", label: "Remove selected" } ],
            rowIdField: "id",
            requestContext: { organizationId: this.#selectedMemberOrganizationId },
            columns:
            [
                { key: "email", label: "Email" },
                { key: "userBadge", label: "User" },
                { key: "addedAt", label: "Added", format: "date" }
            ],
            customFetcher: (parameters) => this.#fetchOrganizationMembersPage(parameters),
            onBulkAction: (actionKey, selectedIds) =>
            {
                if (actionKey === "bulkRemove")
                {
                    this.#handleBulkRemoveMembers(selectedIds);
                }
            }
        });

        this.querySelector('[data-role="list-host"]').appendChild(listView);
    }

    async #fetchOrganizationMembersPage(parameters)
    {
        const organizationId = parameters.context?.organizationId || this.#selectedMemberOrganizationId;
        const queryUrl = `/Organization/Members/List?organizationId=${encodeURIComponent(organizationId)}`;

        let payload;
        try
        {
            const response = await fetch(queryUrl);
            if (!response.ok)
            {
                this.#organizationMembers = [];
                this.#updateMemberCounts(0, 0);
                return { items: [], totalCount: 0 };
            }
            payload = await response.json();
        }
        catch (loadError)
        {
            this.#organizationMembers = [];
            this.#updateMemberCounts(0, 0);
            return { items: [], totalCount: 0 };
        }

        this.#organizationMembers = Array.isArray(payload?.members) ? payload.members : [];
        this.#updateMemberCounts(payload?.currentMemberCount || 0, payload?.maxMembers || 0);

        const searchText = (parameters.search || "").trim().toLowerCase();
        const filteredMembers = searchText.length === 0
            ? this.#organizationMembers
            : this.#organizationMembers.filter(member => (member.email || "").toLowerCase().includes(searchText));

        const pageMembers = filteredMembers.slice(parameters.offset, parameters.offset + parameters.limit);
        const items = pageMembers.map(member =>
        ({
            id: member.id,
            email: member.email,
            userBadge: member.userId && member.userId.length > 0 ? "Account linked" : "Pending first login",
            addedAt: member.addedAt || null
        }));

        return { items: items, totalCount: filteredMembers.length };
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
            counts.innerHTML = `<strong>${current} / ${max}</strong> — capacity reached. Contact CogniumLearn to extend.`;
        }
        else
        {
            counts.innerHTML = `<strong>${current} / ${max}</strong> members (${remainingSlots} slot${remainingSlots === 1 ? "" : "s"} remaining)`;
        }
    }

    async #handleBulkRemoveMembers(memberIds)
    {
        const ids = Array.isArray(memberIds) ? memberIds : [];
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

        if (this.#currentListView)
        {
            this.#currentListView.clearSelection();
        }
        await DialogBox.alert("Members removed", `Removed ${summary.removed} of ${summary.requested}${summary.notFound > 0 ? ` (${summary.notFound} not found)` : ""}.`);
        this.#refreshCurrentList();
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
