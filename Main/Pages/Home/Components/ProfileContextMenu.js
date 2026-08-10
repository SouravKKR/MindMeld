import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeviceManagementDialog from "../../../CommonComponents/DeviceManagementDialog.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import UserIdentityManager from "../../../Globals/Classes/UserIdentityManager.js";
import OrganizationContextRegistry from "../../../Globals/Classes/Organization/OrganizationContextRegistry.js";
import OrganizationViewSwitcher from "../../../Globals/Classes/Organization/OrganizationViewSwitcher.js";
import PlanViewRegistry from "../../../Globals/Classes/View/PlanViewRegistry.js";
import PlanViewSwitcher from "../../../Globals/Classes/View/PlanViewSwitcher.js";
import { settingsMenus } from "../../../Globals/Enumerations/SettingsMenus.js";
import { userRoles } from "../../../Globals/Enumerations/UserRoles.js";

class ProfileContextMenu extends ContextMenu
{
    static tagName = "profile-context-menu";

    #profile = null;

    initialize(position = { x: 0, y: 0 }, profile)
    {
        super.initialize(position);
        this.#profile = profile;
    }

    #handleEvents()
    {
        const viewProfileButton = this.querySelector(".view-profile-button");
        const manageDevicesButton = this.querySelector(".manage-devices-button");
        const logoutButton = this.querySelector(".logout-button");

        viewProfileButton.addEventListener("click", () =>
        {
            this.remove();
            PageNavigator.open("settings-page", { activeTab: settingsMenus.PROFILE });
        });

        manageDevicesButton.addEventListener("click", () =>
        {
            this.remove();
            DeviceManagementDialog.open();
        });

        logoutButton.addEventListener("click", async () =>
        {
            const logoutResponse = await fetch("/Logout");

            if (logoutResponse.ok)
            {
                sessionStorage.clear();
                location.reload();
            }
            else
            {
                DialogBox.alert("Error", "Failed to logout.");
            }
        });
    }

    /**
     * Adds the view switcher: "View as yourself" whenever any other view is
     * active, one "View as <organization>" entry per organization this account
     * belongs to, and — for administrators — one "View as a <tier> user" entry
     * per plan.
     *
     * The exit is emitted FIRST and independently of either list. It used to be
     * nested inside the organization block, which meant an administrator with no
     * organizations could enter a plan sandbox and find no way out of it in this
     * menu at all. Anything that can be entered has to be leavable from here
     * without depending on why it was offered.
     *
     * Read straight from state the app already holds — the registry /GetUser
     * populated, and a shipped constant for the tiers — so the menu never waits
     * on the network and still offers both offline, where the library is on the
     * device and switching to it is perfectly valid.
     */
    #appendViewSwitchEntries()
    {
        const viewProfileButton = this.querySelector(".view-profile-button");

        if (!UserIdentityManager.isPersonalView())
        {
            const personalViewButton = document.createElement("button");
            personalViewButton.className = "view-as-personal-button";
            personalViewButton.textContent = "View as yourself";
            personalViewButton.addEventListener("click", async () =>
            {
                this.remove();

                // Two destinations, one button. Leaving an institute's library
                // and leaving a simulation are different confirmations, so the
                // switcher that owns each is asked rather than a merged third.
                if (UserIdentityManager.isPlanViewContext())
                {
                    await PlanViewSwitcher.switchToPersonalView();
                }
                else
                {
                    await OrganizationViewSwitcher.switchToPersonalView();
                }
            });
            this.insertBefore(personalViewButton, viewProfileButton);
        }

        this.#appendOrganizationViewEntries(viewProfileButton);
        this.#appendPlanViewEntries(viewProfileButton);
    }

    #appendOrganizationViewEntries(viewProfileButton)
    {
        const activeOrganizationId = UserIdentityManager.getOrganizationContextId();

        for (const context of OrganizationContextRegistry.getContexts())
        {
            if (!context || context.organizationId === activeOrganizationId)
            {
                continue;
            }

            const organizationViewButton = document.createElement("button");
            organizationViewButton.className = "view-as-organization-button";
            organizationViewButton.textContent = `View as ${context.organizationName || context.organizationId}`;
            organizationViewButton.addEventListener("click", async () =>
            {
                this.remove();
                await OrganizationViewSwitcher.switchToOrganization(context.organizationId);
            });
            this.insertBefore(organizationViewButton, viewProfileButton);
        }
    }

    /**
     * Administrators only, and gated on the live session role rather than a
     * cached flag so a demoted account stops being offered them at the next menu
     * open. The gate is UX: ViewScopeResolver re-authorises the same role on
     * every request.
     */
    #appendPlanViewEntries(viewProfileButton)
    {
        if (!PlanViewRegistry.isAvailableToCurrentUser())
        {
            return;
        }

        const activePlanTierName = UserIdentityManager.getPlanViewTierName();

        for (const tier of PlanViewRegistry.listTiers())
        {
            if (tier.tierName === activePlanTierName)
            {
                continue;
            }

            const planViewButton = document.createElement("button");
            planViewButton.className = "view-as-plan-button";
            planViewButton.dataset.planTierName = tier.tierName;
            planViewButton.textContent = `View as a ${tier.label} user`;
            planViewButton.addEventListener("click", async () =>
            {
                this.remove();
                await PlanViewSwitcher.switchToPlanView(tier.tierName);
            });
            this.insertBefore(planViewButton, viewProfileButton);
        }
    }

    /**
     * Adds one "Manage <organization>" entry per organization this account
     * administers — as its owner, or as a delegate the owner gave powers to.
     *
     * Fetched rather than read off the user object because standing lives on
     * the organization and the membership row, not on the account. Gated on the
     * role first so an ordinary user never issues a request that would only be
     * refused, and appended after the menu has rendered so the menu never waits
     * on the network.
     */
    async #appendOrganizationEntries()
    {
        const currentUser = window["user"];
        const currentRole = currentUser && typeof currentUser.getRole === "function" ? currentUser.getRole() : userRoles.USER;

        if (currentRole !== userRoles.ORG_ADMIN && currentRole !== userRoles.ADMIN)
        {
            return;
        }

        let organizations = [];
        try
        {
            const response = await fetch("/Organization/Mine/List");
            if (!response.ok)
            {
                return;
            }
            const responseJson = await response.json();
            organizations = Array.isArray(responseJson.organizations) ? responseJson.organizations : [];
        }
        catch (loadError)
        {
            // A profile menu must open whether or not this request succeeds.
            return;
        }

        // A super-admin administers every organization on the platform; listing
        // them all here would bury the three entries this menu exists for. They
        // reach any organization from the admin panel instead.
        if (currentRole === userRoles.ADMIN || organizations.length === 0 || !this.isConnected)
        {
            return;
        }

        const logoutButton = this.querySelector(".logout-button");

        for (const organization of organizations)
        {
            const manageButton = document.createElement("button");
            manageButton.className = "manage-organization-button";
            manageButton.textContent = `Manage ${organization.name}`;
            manageButton.addEventListener("click", () =>
            {
                this.remove();
                PageNavigator.open("organization-page", organization.id);
            });
            this.insertBefore(manageButton, logoutButton);
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <button class="view-profile-button">View Profile</button>
            <button class="manage-devices-button">Manage Devices</button>
            <button class="logout-button">Logout</button>
        `;
        super.connectedCallback();
        this.#handleEvents();
        this.#appendViewSwitchEntries();
        this.#appendOrganizationEntries();
    }
}

customElements.define("profile-context-menu", ProfileContextMenu);
export default ProfileContextMenu;
