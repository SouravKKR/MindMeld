import ContextMenu from "../../../CommonComponents/ContextMenu.js";
import DialogBox from "../../../CommonComponents/DialogBox.js";
import DeviceManagementDialog from "../../../CommonComponents/DeviceManagementDialog.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { settingsMenus } from "../../../Globals/Enumerations/SettingsMenus.js";

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
    }
}

customElements.define("profile-context-menu", ProfileContextMenu);
export default ProfileContextMenu;