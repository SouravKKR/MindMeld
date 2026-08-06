import OrganizationErrorMessages from "../../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { organizationStatus } from "../../../Globals/Enumerations/OrganizationStatus.js";
import { organizationDeckPerkTypes } from "../../../Globals/Enumerations/OrganizationDeckPerkTypes.js";

/**
 * OrganizationOverviewSection
 *
 * What the organization is, and the one thing its owner can change here: its
 * name. Member capacity and the marketplace deck perks are shown read-only,
 * because both are commercial terms only a super-admin sets — surfacing them
 * without an editor is deliberate, so an owner can see what they were sold
 * without being able to grant themselves more of it.
 */
class OrganizationOverviewSection extends HTMLElement
{
    #organizationId = "";
    #organization = null;
    #perks = [];
    #authority = null;
    #onChanged = null;

    initialize(context)
    {
        this.#organizationId = context.organizationId;
        this.#organization = context.organization;
        this.#perks = Array.isArray(context.perks) ? context.perks : [];
        this.#authority = context.authority;
        this.#onChanged = typeof context.onChanged === "function" ? context.onChanged : () => {};
    }

    connectedCallback()
    {
        const bMayRename = this.#authority?.isOwner === true || this.#authority?.isSuperAdmin === true;

        this.innerHTML = `
            <h2 class="organization-section-title">Overview</h2>

            <div class="organization-summary-grid">
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Status</span>
                    <span class="organization-summary-value">${OrganizationOverviewSection.#escapeHtml(OrganizationOverviewSection.#describeStatus(this.#organization.status))}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Members</span>
                    <span class="organization-summary-value">${this.#organization.currentMemberCount} / ${this.#organization.maxMembers}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Owner</span>
                    <span class="organization-summary-value">${OrganizationOverviewSection.#escapeHtml(this.#organization.adminEmail)}</span>
                </div>
                <div class="organization-summary-card">
                    <span class="organization-summary-label">Currency</span>
                    <span class="organization-summary-value">${OrganizationOverviewSection.#escapeHtml(this.#organization.currency)}</span>
                </div>
            </div>

            <div class="admin-panel-add-error" data-role="error" hidden></div>

            ${bMayRename ? `
                <h3 class="organization-section-heading">Name</h3>
                <div class="organization-form-grid">
                    <label class="admin-panel-add-field">
                        <span>Organization name</span>
                        <input type="text" class="organization-rename-input" maxlength="256" value="${OrganizationOverviewSection.#escapeHtml(this.#organization.name)}">
                    </label>
                </div>
                <div class="organization-form-actions">
                    <button type="button" class="admin-panel-add-submit organization-rename">Save name</button>
                </div>
                <p class="organization-action-status" data-role="rename-status"></p>
            ` : ""}

            <h3 class="organization-section-heading">Marketplace deck perks</h3>
            <p class="admin-panel-add-subtitle">Set by CogniumLearn as part of your agreement. These discount marketplace decks for your members; decks you publish yourself are always free to them.</p>
            <div data-role="perks"></div>
        `;

        this.#renderPerks();

        if (bMayRename)
        {
            this.querySelector(".organization-rename").addEventListener("click", () => this.#handleRename());
        }
    }

    #renderPerks()
    {
        const perksHost = this.querySelector('[data-role="perks"]');
        const perks = this.#perks;

        if (perks.length === 0)
        {
            perksHost.innerHTML = `<p class="admin-panel-add-subtitle">No perks. Members pay the regular price for every marketplace deck.</p>`;
            return;
        }

        perksHost.innerHTML = `
            <div class="organization-table-scroll">
                <table class="admin-panel-table">
                    <thead><tr><th>Deck</th><th>Perk</th><th>Value</th><th>Claim window</th></tr></thead>
                    <tbody>
                        ${perks.map(perk => `
                            <tr>
                                <td>${OrganizationOverviewSection.#escapeHtml(perk.deckId)}</td>
                                <td>${OrganizationOverviewSection.#escapeHtml(OrganizationOverviewSection.#describePerkType(perk.perkType))}</td>
                                <td>${OrganizationOverviewSection.#escapeHtml(OrganizationOverviewSection.#describePerkValue(perk))}</td>
                                <td>${perk.durationDays > 0 ? `${perk.durationDays} day${perk.durationDays === 1 ? "" : "s"} from joining` : "No limit"}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        `;
    }

    async #handleRename()
    {
        const errorElement = this.querySelector('[data-role="error"]');
        const statusElement = this.querySelector('[data-role="rename-status"]');
        const renameButton = this.querySelector(".organization-rename");
        const newName = this.querySelector(".organization-rename-input").value.trim();

        errorElement.hidden = true;
        statusElement.textContent = "";
        statusElement.classList.remove("organization-action-status-success", "organization-action-status-failure");

        if (newName.length === 0 || newName.length > 256)
        {
            statusElement.textContent = "Enter a name between 1 and 256 characters.";
            statusElement.classList.add("organization-action-status-failure");
            return;
        }

        renameButton.disabled = true;
        renameButton.textContent = "Saving…";

        try
        {
            const response = await fetch("/Organization/Rename",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ organizationId: this.#organizationId, name: newName })
            });
            const responseJson = await response.json().catch(() => ({}));

            if (!response.ok || responseJson.success === false)
            {
                const message = OrganizationErrorMessages.describe(responseJson.error, response.status);
                errorElement.textContent = message;
                errorElement.hidden = false;
                statusElement.textContent = message;
                statusElement.classList.add("organization-action-status-failure");
                return;
            }

            statusElement.textContent = `Renamed to "${newName}".`;
            statusElement.classList.add("organization-action-status-success");
            this.#organization.name = newName;
            await this.#onChanged();
        }
        catch (renameError)
        {
            const message = renameError.message || "The request could not be sent.";
            errorElement.textContent = message;
            errorElement.hidden = false;
            statusElement.textContent = message;
            statusElement.classList.add("organization-action-status-failure");
        }
        finally
        {
            renameButton.disabled = false;
            renameButton.textContent = "Save name";
        }
    }

    static #describeStatus(statusValue)
    {
        if (statusValue === organizationStatus.ACTIVE)
        {
            return "Active";
        }
        if (statusValue === organizationStatus.SUSPENDED)
        {
            return "Suspended";
        }
        return "Pending";
    }

    static #describePerkType(perkType)
    {
        if (perkType === organizationDeckPerkTypes.FREE)
        {
            return "Free for members";
        }
        if (perkType === organizationDeckPerkTypes.FIXED_OVERRIDE)
        {
            return "Fixed price";
        }
        if (perkType === organizationDeckPerkTypes.PERCENTAGE_DISCOUNT)
        {
            return "Percentage discount";
        }
        return String(perkType);
    }

    static #describePerkValue(perk)
    {
        if (perk.perkType === organizationDeckPerkTypes.FREE)
        {
            return "—";
        }
        if (perk.perkType === organizationDeckPerkTypes.PERCENTAGE_DISCOUNT)
        {
            return `${perk.perkValue}% off`;
        }
        return String(perk.perkValue);
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

customElements.define("organization-overview-section", OrganizationOverviewSection);
export default OrganizationOverviewSection;
