import HeaderComponent from "../../CommonComponents/HeaderComponent.js";
import OrganizationOverviewSection from "./Components/OrganizationOverviewSection.js";
import OrganizationMembersSection from "./Components/OrganizationMembersSection.js";
import OrganizationCreditsSection from "./Components/OrganizationCreditsSection.js";
import OrganizationPermissionsSection from "./Components/OrganizationPermissionsSection.js";
import OrganizationDecksSection from "./Components/OrganizationDecksSection.js";
import OrganizationErrorMessages from "../../Globals/Classes/Organization/OrganizationErrorMessages.js";
import { organizationPageSections } from "../../Globals/Enumerations/OrganizationPageSections.js";
import { organizationDelegatePowers } from "../../Globals/Enumerations/OrganizationDelegatePowers.js";

/**
 * OrganizationPage
 *
 * The one place an organization is administered, by its owner, by a delegate,
 * or by a super-admin. Sections live in a left rail: Overview and Members
 * today, with Permissions, Credits, Decks and Reports arriving as their
 * features land.
 *
 * This replaces a modal that had grown to hold two tables inside a 480px form.
 * A dialog was the wrong container the moment this surface acquired a second
 * job, and the symptoms showed it — content clipped below the viewport with no
 * way to scroll to it.
 *
 * Every section is gated twice: the rail only offers what the caller's stored
 * powers allow, and each endpoint re-checks those powers server-side. The
 * client-side gate is there so nobody is shown a door they cannot open, never
 * as the lock itself.
 */
class OrganizationPage extends HTMLElement
{
    /**
     * The rail, in display order. `requiredPower` of null means "anyone with
     * standing in this organization"; otherwise the caller must hold that
     * OrganizationDelegatePowers flag (owners and super-admins hold them all).
     */
    static #SECTION_DEFINITIONS =
    [
        {
            section: organizationPageSections.OVERVIEW,
            label: "Overview",
            tagName: "organization-overview-section",
            requiredPower: null
        },
        {
            section: organizationPageSections.MEMBERS,
            label: "Members",
            tagName: "organization-members-section",
            requiredPower: organizationDelegatePowers.MANAGE_MEMBERS
        },
        {
            // Readable by anyone with standing, for the same reason as Credits:
            // an owner should be able to see what their delegates configured
            // without holding the power to change it. The section renders its
            // controls disabled without SET_PERMISSIONS, and the write endpoint
            // refuses regardless.
            section: organizationPageSections.PERMISSIONS,
            label: "Permissions",
            tagName: "organization-permissions-section",
            requiredPower: null
        },
        {
            // Readable by anyone with standing — an owner reviewing what a
            // delegate spent should not need the delegate's own power to look.
            // The section hides its spending controls without it.
            section: organizationPageSections.CREDITS,
            label: "Credits",
            tagName: "organization-credits-section",
            requiredPower: null
        },
        {
            // Readable by anyone with standing; publishing and withdrawing need
            // PUBLISH_DECKS, which the section checks before rendering either
            // control and each endpoint re-checks before acting.
            section: organizationPageSections.DECKS,
            label: "Decks",
            tagName: "organization-decks-section",
            requiredPower: null
        }
    ];

    #organizationId = "";
    #organizationSnapshot = null;
    #perks = [];
    #authority = null;
    #activeSection = organizationPageSections.OVERVIEW;

    initialize(organizationId, initialSection)
    {
        this.#organizationId = typeof organizationId === "string" ? organizationId : "";
        if (Number.isInteger(initialSection))
        {
            this.#activeSection = initialSection;
        }
    }

    async connectedCallback()
    {
        this.setAttribute("page", "");
        this.innerHTML = `
            <header-component title="Organization"></header-component>
            <div class="organization-page-body">
                <div class="organization-page-status" data-role="status">Loading…</div>
            </div>
        `;

        await this.#loadAndRender();
    }

    async onPageResumed()
    {
        await this.#loadAndRender();
    }

    async #loadAndRender()
    {
        const bodyElement = this.querySelector(".organization-page-body");

        if (this.#organizationId.length === 0)
        {
            bodyElement.innerHTML = `<div class="organization-page-status">No organization was selected.</div>`;
            return;
        }

        let responseJson = null;
        let statusCode = 0;
        try
        {
            const response = await fetch(`/Organization/Get?organizationId=${encodeURIComponent(this.#organizationId)}`);
            statusCode = response.status;
            responseJson = await response.json().catch(() => ({}));
            if (!response.ok || responseJson.success === false)
            {
                bodyElement.innerHTML = `<div class="organization-page-status organization-page-status-error"></div>`;
                bodyElement.querySelector(".organization-page-status").textContent = OrganizationErrorMessages.describe(responseJson.error, statusCode);
                return;
            }
        }
        catch (loadError)
        {
            bodyElement.innerHTML = `<div class="organization-page-status organization-page-status-error"></div>`;
            bodyElement.querySelector(".organization-page-status").textContent = loadError.message || "Could not load this organization.";
            return;
        }

        this.#organizationSnapshot = responseJson.organization;
        this.#perks = Array.isArray(responseJson.perks) ? responseJson.perks : [];
        this.#authority = responseJson.authority || { isSuperAdmin: false, isOwner: false, delegatePowers: organizationDelegatePowers.NONE };

        const visibleSections = OrganizationPage.#SECTION_DEFINITIONS.filter(definition => this.#mayUseSection(definition));
        if (visibleSections.length === 0)
        {
            bodyElement.innerHTML = `<div class="organization-page-status">You don't have permission to manage this organization.</div>`;
            return;
        }

        if (!visibleSections.some(definition => definition.section === this.#activeSection))
        {
            this.#activeSection = visibleSections[0].section;
        }

        this.querySelector("header-component").setAttribute("title", this.#organizationSnapshot.name || "Organization");

        bodyElement.innerHTML = `
            <nav class="organization-page-rail" data-role="rail">
                ${visibleSections.map(definition => `
                    <button type="button" class="organization-page-rail-item ${definition.section === this.#activeSection ? "organization-page-rail-item-active" : ""}" data-section="${definition.section}">
                        ${OrganizationPage.#escapeHtml(definition.label)}
                    </button>
                `).join("")}
            </nav>
            <section class="organization-page-section" data-role="section"></section>
        `;

        for (const railButton of bodyElement.querySelectorAll(".organization-page-rail-item"))
        {
            railButton.addEventListener("click", (clickEvent) =>
            {
                this.#activeSection = Number(clickEvent.currentTarget.dataset.section);
                for (const otherButton of bodyElement.querySelectorAll(".organization-page-rail-item"))
                {
                    otherButton.classList.toggle("organization-page-rail-item-active", Number(otherButton.dataset.section) === this.#activeSection);
                }
                this.#renderActiveSection();
            });
        }

        this.#renderActiveSection();
    }

    #renderActiveSection()
    {
        const sectionHost = this.querySelector('[data-role="section"]');
        const definition = OrganizationPage.#SECTION_DEFINITIONS.find(candidate => candidate.section === this.#activeSection);
        if (!definition)
        {
            return;
        }

        sectionHost.innerHTML = "";
        const sectionElement = document.createElement(definition.tagName);
        sectionElement.initialize
        ({
            organizationId: this.#organizationId,
            organization: this.#organizationSnapshot,
            perks: this.#perks,
            authority: this.#authority,
            onChanged: () => this.#loadAndRender()
        });
        sectionHost.appendChild(sectionElement);
    }

    /**
     * Whether the caller may open a section. Owners and super-admins hold every
     * power, so this reduces to a flag test for everyone.
     */
    #mayUseSection(definition)
    {
        if (definition.requiredPower === null)
        {
            return true;
        }
        const heldPowers = Number.isInteger(this.#authority?.delegatePowers) ? this.#authority.delegatePowers : organizationDelegatePowers.NONE;
        return (heldPowers & definition.requiredPower) === definition.requiredPower;
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

customElements.define("organization-page", OrganizationPage);
export default OrganizationPage;
