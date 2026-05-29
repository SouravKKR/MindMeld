import ProfileContextMenu from "./ProfileContextMenu.js";

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
        const displayPicture = user.getProfilePictureUrl?.()
            || user.getAdditionalData()?.displayPicture
            || "/Globals/Assets/Images/Icons/ProfileIcon.svg";

        this.innerHTML =
        `
            <img class="profile-icon" src="${displayPicture}" alt="Profile Icon">
            <div class="profile-display-name">${displayName}</div>
        `;
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
        this.#renderLoggedOut();
        this.#handleEvents();
    }
}

customElements.define("profile-component", ProfileComponent);
export default ProfileComponent;
