import ProfileContextMenu from "./ProfileContextMenu.js";
import UserIdentityManager from "../../../Globals/Classes/UserIdentityManager.js";
import PlanViewRegistry from "../../../Globals/Classes/View/PlanViewRegistry.js";

class ProfileComponent extends HTMLElement
{

    refresh()
    {
        if (window["user"])
        {
            this.#renderLoggedIn(window["user"]);
        }
        else
        {
            this.#renderLoggedOut();
        }
    }

    #renderLoggedIn(user)
    {
        const displayName = user.getDisplayName();
        // Offline (stale) sessions carry an inlined data-URL avatar under this
        // key — the cross-origin provider URL is unreachable offline and the
        // service worker only caches same-origin assets. Prefer it when present.
        const displayPicture = user.getAdditionalData?.()?.offlineProfilePictureDataUrl
            || user.getProfilePictureUrl?.()
            || user.getAdditionalData()?.displayPicture
            || "/Globals/Assets/Images/Icons/ProfileIcon.svg";

        this.innerHTML =
        `
            <img class="profile-icon" src="${displayPicture}" alt="Profile Icon" referrerpolicy="no-referrer">
            <div class="profile-display-name">${displayName}</div>
            ${ProfileComponent.#buildViewBadgeMarkup()}
        `;
    }

    /**
     * A short marker on the pill itself when a non-personal view is active.
     *
     * ViewContextIndicator is the real signal and the real exit — this is the
     * second one, on the control a user clicks to change view, so the menu they
     * are about to open is labelled with the state it will change.
     */
    static #buildViewBadgeMarkup()
    {
        const planViewTierName = UserIdentityManager.getPlanViewTierName();

        if (planViewTierName.length > 0)
        {
            return `<div class="profile-view-badge" data-view-kind="PLAN">${PlanViewRegistry.getLabel(planViewTierName)}</div>`;
        }

        if (UserIdentityManager.isOrganizationContext())
        {
            return `<div class="profile-view-badge" data-view-kind="ORGANIZATION">Org</div>`;
        }

        return "";
    }

    #renderLoggedOut()
    {
        this.innerHTML =
        `
            <img class="profile-icon" src="./Globals/Assets/Images/Icons/ProfileIcon.svg" alt="Profile Icon">
            <div class="profile-display-name">Login</div>
        `;
    }

    #handleEvents()
    {
        this.addEventListener("click", (clickEvent) =>
        {
            clickEvent.stopPropagation();

            if (window["user"])
            {
                ProfileContextMenu.create({ x: clickEvent.clientX, y: clickEvent.clientY }, window["user"]);
            }
            else
            {
                window.location.href = `${window.location.origin}/Login?provider=GOOGLE`;
            }
        });
    }

    connectedCallback()
    {
        // Render from the live session rather than assuming logged-out. This
        // element is re-created on every Home remount — an organization view
        // switch, a return from Progress, a sync reset — and the refresh()
        // broadcast in AuthenticationEvents only reaches components that were
        // already mounted when an authentication event fired. Assuming
        // logged-out here left the pill reading "Login" for a signed-in user
        // until the next full page load.
        this.refresh();
        this.#handleEvents();
    }
}

customElements.define("profile-component", ProfileComponent);
export default ProfileComponent;
