import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeviceManagementDialog from "../../../CommonComponents/DeviceManagementDialog.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import UserIdentityManager from "../../../Globals/Classes/UserIdentityManager.js";
import OrganizationContextRegistry from "../../../Globals/Classes/Organization/OrganizationContextRegistry.js";
import OrganizationViewSwitcher from "../../../Globals/Classes/Organization/OrganizationViewSwitcher.js";
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
     * Adds the view switcher: one "View as <organization>" entry per
     * organization this account belongs to, plus "View as yourself" while one of
     * them is active.
     *
     * Read straight from the registry /GetUser already populated, so the menu
     * never waits on the network for the entries most members care about — and
     * so it still offers them offline, where the library is on the device and
     * switching to it is perfectly valid.
     *
     * Everyone who belongs to an organization gets these, unlike the "Manage"
     * entries below, which are for the people who administer one.
     */
    #appendViewSwitchEntries()
    {
        const contexts = OrganizationContextRegistry.getContexts();
        if (contexts.length === 0)
        {
            return;
        }

        const activeOrganizationId = UserIdentityManager.getOrganizationContextId();
        const viewProfileButton = this.querySelector(".view-profile-button");

        if (activeOrganizationId.length > 0)
        {
            const personalViewButton = document.createElement("button");
            personalViewButton.className = "view-as-personal-button";
            personalViewButton.textContent = "View as yourself";
            personalViewButton.addEventListener("click", async () =>
            {
                this.remove();
                await OrganizationViewSwitcher.switchToPersonalView();
            });
            this.insertBefore(personalViewButton, viewProfileButton);
        }

        for (const context of contexts)
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
