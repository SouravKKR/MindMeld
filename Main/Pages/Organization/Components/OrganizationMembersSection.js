import DialogBox from "../../../CommonComponents/DialogBox.js";
import AdminListView from "../../../CommonComponents/AdminListView.js";
import AddMembersDialog from "../../AdminPanel/Components/AddMembersDialog.js";
import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import SpreadsheetWriter from "../../../Globals/Classes/SpreadsheetWriter.js";
import { organizationDelegatePowers } from "../../../Globals/Enumerations/OrganizationDelegatePowers.js";

/**
 * OrganizationMembersSection
 *
 * The roster: who is in the organization, what each person is tagged with, and
 * the controls to add, remove and delegate.
 *
 * Searching, filtering, sorting and paging all happen in the database through
 * the shared admin-list framework. The roster used to be pulled whole and
 * sliced in the browser, which meant every keystroke moved the entire
 * membership over the wire and the pager was decorative.
 *
 * Two ways to remove people, because they answer different questions:
 *   - tick rows and remove the selection, when the people are known by name
 *   - remove everything the current filter matches, when they are known by
 *     description ("first-years with roll numbers A0100 to A0450"). That one
 *     always runs a dry run first and puts the real number in the confirmation,
 *     because the danger of removal-by-filter is a filter that matches more
 *     people than the person writing it expects.
 *
 * Delegate powers are editable by the owner (and super-admins) only — a
 * delegate holding MANAGE_MEMBERS can add and remove people but cannot appoint
 * another delegate, or that one power would escalate into all of them. The
 * server enforces the same rule; hiding the control only avoids offering
 * something that would be refused.
 */
class OrganizationMembersSection extends HTMLElement
{
    static #POWER_DEFINITIONS =
    [
        { power: organizationDelegatePowers.MANAGE_MEMBERS, label: "Members" },
        { power: organizationDelegatePowers.DISTRIBUTE_CREDITS, label: "Credits" },
        { power: organizationDelegatePowers.SET_PERMISSIONS, label: "Permissions" },
        { power: organizationDelegatePowers.PUBLISH_DECKS, label: "Decks" }
    ];

    #organizationId = "";
    #organization = null;
    #authority = null;
    #onChanged = null;
    #listView = null;
    #knownMembers = [];

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#organization = context.organization;
        this.#authority = context.authority;
        this.#onChanged = typeof context.onChanged === "function" ? context.onChanged : () => {};
    }

    connectedCallback()
    {
        this.innerHTML = `
            <h2 class="organization-section-title">Members</h2>
            <div class="organization-members-toolbar">
                <p class="admin-panel-add-subtitle" data-role="capacity">${this.#organization.currentMemberCount} of ${this.#organization.maxMembers} seats used.</p>
                <div class="organization-form-actions">
                    <button type="button" class="organization-secondary-button organization-export-members">Export</button>
                    <button type="button" class="organization-secondary-button organization-remove-by-filter">Remove everything filtered</button>
                    <button type="button" class="admin-panel-add-submit organization-add-members">Add members</button>
                </div>
            </div>
            <div class="admin-panel-add-error" data-role="error" hidden></div>
            <p class="organization-action-status" data-role="status"></p>
            <div data-role="list-host"></div>
            <div data-role="powers-host"></div>
        `;

        this.querySelector(".organization-add-members").addEventListener("click", () => this.#handleAddMembers());
        this.querySelector(".organization-remove-by-filter").addEventListener("click", () => this.#handleRemoveByFilter());
        this.querySelector(".organization-export-members").addEventListener("click", () => this.#handleExport());

        this.#mountListView();
        this.#renderDelegatePanel();
    }

    #mountListView()
    {
        const listHost = this.querySelector('[data-role="list-host"]');
        listHost.innerHTML = "";

        const listView = new AdminListView();
        listView.configure
        ({
            searchEnabled: true,
            selectable: true,
            rowIdField: "id",
            bulkActions: [{ actionKey: "removeSelected", label: "Remove selected" }],
            onBulkAction: (actionKey, selectedRowIds) =>
            {
                if (actionKey === "removeSelected")
                {
                    this.#handleRemoveSelected(selectedRowIds);
                }
            },
            customFetcher: (parameters) => this.#fetchMembersPage(parameters),
            customMetadataFetcher: () => this.#fetchMembersMetadata()
        });

        listHost.appendChild(listView);
        this.#listView = listView;
    }

    /**
     * The list metadata for THIS organization — its columns and the filter set
     * built from the attribute keys and tags it actually uses, so an institute
     * that never uploads a stream column is never offered a stream filter.
     */
    async #fetchMembersMetadata()
    {
        const response = await fetch(`/Organization/Lists/Metadata?organizationId=${encodeURIComponent(this.#organizationId)}`);
        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            throw new Error(OrganizationErrorMessages.describe(responseJson.error, response.status));
        }
        return await response.json();
    }

    async #fetchMembersPage(parameters)
    {
        const response = await fetch("/Organization/Lists/Query",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify
            ({
                organizationId: this.#organizationId,
                search: parameters.search,
                filters: parameters.filters,
                sort: parameters.sort,
                limit: parameters.limit,
                offset: parameters.offset
            })
        });

        if (!response.ok)
        {
            const responseJson = await response.json().catch(() => ({}));
            throw new Error(OrganizationErrorMessages.describe(responseJson.error, response.status));
        }

        const page = await response.json();
        this.#knownMembers = Array.isArray(page.items) ? page.items : [];
        this.#renderDelegatePanel();
        return page;
    }

    /**
     * The delegate editor, kept out of the list itself: powers belong to a
     * handful of people, and a checkbox grid on every row of a thousand-member
     * roster would drown the roster it is attached to.
     */
    #renderDelegatePanel()
    {
        const powersHost = this.querySelector('[data-role="powers-host"]');
        if (!powersHost)
        {
            return;
        }

        const bMayEditPowers = this.#authority?.isOwner === true || this.#authority?.isSuperAdmin === true;
        if (!bMayEditPowers)
        {
            powersHost.innerHTML = "";
            return;
        }

        const candidateMembers = this.#knownMembers.slice(0, 200);
        if (candidateMembers.length === 0)
        {
            powersHost.innerHTML = "";
            return;
        }

        powersHost.innerHTML = `
            <h3 class="organization-section-heading">Delegates</h3>
            <p class="admin-panel-add-subtitle">Hand part of your job to a member. Powers apply the next time that person signs in, and a delegate can never appoint another delegate.</p>
            <div class="organization-form-grid">
                <label class="admin-panel-add-field">
                    <span>Member</span>
                    <select class="organization-delegate-picker">
                        ${candidateMembers.map(member => `<option value="${OrganizationMembersSection.#escapeHtml(member.id)}">${OrganizationMembersSection.#escapeHtml(member.email)}</option>`).join("")}
                    </select>
                </label>
            </div>
            <div class="organization-power-grid" data-role="power-grid"></div>
            <div class="organization-form-actions">
                <button type="button" class="organization-secondary-button organization-save-powers">Save powers</button>
            </div>
            <p class="organization-action-status" data-role="powers-status"></p>
        `;

        const picker = powersHost.querySelector(".organization-delegate-picker");
        const renderPowerGrid = () =>
        {
            const selectedMember = candidateMembers.find(member => member.id === picker.value);
            const heldPowers = Number.isInteger(selectedMember?.delegatePowers) ? selectedMember.delegatePowers : 0;
            powersHost.querySelector('[data-role="power-grid"]').innerHTML = OrganizationMembersSection.#POWER_DEFINITIONS.map(definition => `
                <label class="organization-power-toggle">
                    <input type="checkbox" data-power="${definition.power}" ${(heldPowers & definition.power) === definition.power ? "checked" : ""}>
                    <span>${OrganizationMembersSection.#escapeHtml(definition.label)}</span>
                </label>
            `).join("");
        };

        picker.addEventListener("change", renderPowerGrid);
        renderPowerGrid();

        powersHost.querySelector(".organization-save-powers").addEventListener("click", (clickEvent) =>
        {
            this.#handleSavePowers(picker.value, powersHost, clickEvent.currentTarget);
        });
    }

    async #handleAddMembers()
    {
        const bChanged = await AddMembersDialog.show
        ({
            organizationId: this.#organizationId,
            existingMembers: this.#knownMembers
        });

        if (bChanged)
        {
            // The filter set is rebuilt from scratch: an import can introduce a
            // brand-new column, which must become a filter without a reload.
            this.#mountListView();
            await this.#onChanged();
        }
    }

    async #handleExport()
    {
        this.#clearStatus();

        try
        {
            const response = await fetch("/Organization/Lists/Query",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    organizationId: this.#organizationId,
                    search: this.#listView ? this.#listView.getSearchValue() : "",
                    filters: this.#listView ? this.#listView.getFilterValues() : {},
                    limit: 200,
                    offset: 0
                })
            });

            const page = await response.json().catch(() => ({}));
            if (!response.ok)
            {
                this.#showError(OrganizationErrorMessages.describe(page.error, response.status));
                return;
            }

            const items = Array.isArray(page.items) ? page.items : [];
            if (items.length === 0)
            {
                this.#showStatus("Nothing to export — no member matches the current filters.", false);
                return;
            }

            const columnKeys = Object.keys(items[0]).filter(key => key !== "id" && key !== "delegatePowers" && key !== "tags" && key !== "userId");
            const rows = [columnKeys, ...items.map(item => columnKeys.map(key => item[key]))];

            SpreadsheetWriter.downloadWorkbook(rows, `CogniumLearn-Members-${this.#organization.name}`, "Members");
            this.#showStatus(`Exported ${items.length} member${items.length === 1 ? "" : "s"}.`, true);
        }
        catch (exportError)
        {
            this.#showError(exportError.message || "The export could not be produced.");
        }
    }

    async #handleRemoveSelected(selectedRowIds)
    {
        if (!Array.isArray(selectedRowIds) || selectedRowIds.length === 0)
        {
            return;
        }

        const bConfirmed = await DialogBox.confirm
        (
            "Remove members",
            `Remove ${selectedRowIds.length} member${selectedRowIds.length === 1 ? "" : "s"}? They lose everything this organization provides — its decks and its permissions — on their next sync. Credits already given to them stay theirs, and any recurring grant to them stops.`
        );

        if (!bConfirmed)
        {
            return;
        }

        this.#clearStatus();

        try
        {
            const response = await fetch("/Organization/Members/BulkRemove",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, memberIds: selectedRowIds })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            const removedCount = responseJson.summary?.removed || 0;
            this.#showStatus(`Removed ${removedCount} member${removedCount === 1 ? "" : "s"}.`, true);
            this.#listView.clearSelection();
            this.#listView.refresh();
            await this.#onChanged();
        }
        catch (removeError)
        {
            this.#showError(removeError.message || "The request could not be sent.");
        }
    }

    async #handleRemoveByFilter()
    {
        const searchValue = this.#listView ? this.#listView.getSearchValue() : "";
        const filterValues = this.#listView ? this.#listView.getFilterValues() : {};

        this.#clearStatus();

        let dryRunJson = null;
        try
        {
            const dryRunResponse = await fetch("/Organization/Members/RemoveByFilter",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, search: searchValue, filters: filterValues, dryRun: true })
            });
            dryRunJson = await dryRunResponse.json().catch(() => ({}));

            if (!dryRunResponse.ok || dryRunJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(dryRunJson.error, dryRunResponse.status));
                return;
            }
        }
        catch (dryRunError)
        {
            this.#showError(dryRunError.message || "The request could not be sent.");
            return;
        }

        if (dryRunJson.matchedCount === 0)
        {
            this.#showStatus("No member matches the current filters.", false);
            return;
        }

        const sampleEmails = (dryRunJson.sample || []).map(entry => entry.email).join(", ");
        const bConfirmed = await DialogBox.confirm
        (
            "Remove everything filtered",
            `This removes ${dryRunJson.matchedCount} member${dryRunJson.matchedCount === 1 ? "" : "s"}, including ${sampleEmails}${dryRunJson.matchedCount > (dryRunJson.sample || []).length ? ", and others" : ""}. They lose this organization's decks and permissions on their next sync. Credits already given to them stay theirs. This cannot be undone.`
        );

        if (!bConfirmed)
        {
            return;
        }

        try
        {
            const response = await fetch("/Organization/Members/RemoveByFilter",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, search: searchValue, filters: filterValues, dryRun: false })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                this.#showError(OrganizationErrorMessages.describe(responseJson.error, response.status));
                return;
            }

            this.#showStatus(`Removed ${responseJson.removed} member${responseJson.removed === 1 ? "" : "s"}.`, true);
            this.#listView.clearSelection();
            this.#listView.refresh();
            await this.#onChanged();
        }
        catch (removeError)
        {
            this.#showError(removeError.message || "The request could not be sent.");
        }
    }

    async #handleSavePowers(memberId, powersHost, triggerButton)
    {
        let delegatePowers = organizationDelegatePowers.NONE;
        for (const checkbox of powersHost.querySelectorAll('input[type="checkbox"][data-power]'))
        {
            if (checkbox.checked)
            {
                delegatePowers = delegatePowers | Number(checkbox.dataset.power);
            }
        }

        const statusElement = powersHost.querySelector('[data-role="powers-status"]');
        statusElement.textContent = "";
        statusElement.classList.remove("organization-action-status-success", "organization-action-status-failure");
        triggerButton.disabled = true;
        triggerButton.textContent = "Saving…";

        try
        {
            const response = await fetch("/Organization/Members/SetDelegatePowers",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, memberId: memberId, delegatePowers: delegatePowers })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                statusElement.textContent = OrganizationErrorMessages.describe(responseJson.error, response.status);
                statusElement.classList.add("organization-action-status-failure");
                return;
            }

            statusElement.textContent = delegatePowers === organizationDelegatePowers.NONE
                ? "Powers revoked."
                : "Powers saved. They take effect the next time this person signs in.";
            statusElement.classList.add("organization-action-status-success");
            this.#listView.refresh();
        }
        catch (saveError)
        {
            statusElement.textContent = saveError.message || "The request could not be sent.";
            statusElement.classList.add("organization-action-status-failure");
        }
        finally
        {
            triggerButton.disabled = false;
            triggerButton.textContent = "Save powers";
        }
    }

    #showError(message)
    {
        const errorElement = this.querySelector('[data-role="error"]');
        errorElement.textContent = message;
        errorElement.hidden = false;
        this.#showStatus(message, false);
    }

    #showStatus(message, bSucceeded)
    {
        const statusElement = this.querySelector('[data-role="status"]');
        statusElement.textContent = message || "";
        statusElement.classList.toggle("organization-action-status-success", bSucceeded === true);
        statusElement.classList.toggle("organization-action-status-failure", bSucceeded === false);
    }

    #clearStatus()
    {
        this.querySelector('[data-role="error"]').hidden = true;
        this.#showStatus("", null);
    }

    static #escapeHtml(rawString)
    {
        if (rawString === null || rawString === undefined)
        {
            return "";
        }
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
}

customElements.define("organization-members-section", OrganizationMembersSection);
export default OrganizationMembersSection;
