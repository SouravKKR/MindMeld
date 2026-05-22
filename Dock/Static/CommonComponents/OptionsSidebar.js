import PageNavigator from "../Globals/Classes/PageNavigator.js";
import Deck from "../Globals/Model/Deck.js";
import DialogBox from "./DialogBox.js";
import TutorialEngine from "../Globals/Classes/TutorialEngine.js";
import AuthenticationEvents from "../Globals/Events/AuthenticationEvents.js";
import { userRoles } from "../Globals/Enumerations/UserRoles.js";
import Persistence from "../Globals/Classes/Persistence.js";
import Profile from "../Globals/Classes/Profile.js";

class OptionsSidebar extends HTMLElement
{
    static get()
    {
        const existing = document.querySelector('options-sidebar');
        if(existing) return existing;

        const newElement = document.createElement('options-sidebar');
        document.body.appendChild(newElement);

        return newElement;
    }

    static open()
    {
        const sidebar = OptionsSidebar.get();

        if (sidebar.hasAttribute("open")) return;

        sidebar.getBoundingClientRect();

        requestAnimationFrame(() =>
        {
            sidebar.setAttribute("open", "");
        });
    }


    static close()
    {
        OptionsSidebar.get().removeAttribute("open");
    }

    static toggle()
    {
        OptionsSidebar.get().hasAttribute("open") ? OptionsSidebar.close() : OptionsSidebar.open();
    }

    #handleEvents()
    {
        const importButton = this.querySelector(".import-button");
        const tutorialButton = this.querySelector(".tutorial-button");
        const aboutButton = this.querySelector(".about-button");
        const settingsButton = this.querySelector(".settings-button");
        const clearDataButton = this.querySelector(".clear-data-button");
        const adminPanelButton = this.querySelector(".admin-panel-button");

        document.body.addEventListener("click", () => OptionsSidebar.close());

        if (adminPanelButton)
        {
            adminPanelButton.addEventListener("click", () =>
            {
                PageNavigator.open("admin-panel-page");
            });
        }

        if (settingsButton)
        {
            settingsButton.addEventListener("click", async () =>
            {
                if(!window["user"])
                {
                    await DialogBox.alert("Sign in required", "You must be signed in to view settings.");
                    return;
                }
                PageNavigator.open("settings-page");
            });
        }

        if (clearDataButton)
        {
            clearDataButton.addEventListener("click", async () =>
            {
                const confirmed = await DialogBox.confirm
                (
                    "Clear local data?",
                    "This will erase every deck, card, and progress record stored on this device and sign you out. Your data on MindMeld's servers is NOT affected — the next sign-in re-syncs everything from the server. This cannot be undone."
                );

                if (!confirmed)
                {
                    return;
                }

                try
                {
                    await Persistence.reset();
                }
                catch (resetError)
                {
                    console.error("[OptionsSidebar] Local data wipe failed:", resetError);
                }

                try
                {
                    await Profile.logout();
                }
                catch (logoutError)
                {
                    console.error("[OptionsSidebar] Server logout failed:", logoutError);
                }

                // Hard reload so every in-memory model (Deck.#idMap,
                // Persistence state, all PageNavigator pages) tears down
                // cleanly. The next boot lands on the sign-in screen
                // because Profile.#user is null and the sessionId cookie
                // was cleared by the /Logout endpoint.
                window.location.reload();
            });
        }

        aboutButton.addEventListener("click", () =>
        {
            console.log("Opening about page");
            PageNavigator.open("mindmeld-about-page");
        });

        if (tutorialButton)
        {
            tutorialButton.addEventListener("click", () =>
            {
                if (TutorialEngine.isRunning())
                {
                    // Already running — nothing to do, the overlay is on screen.
                    return;
                }

                PageNavigator.open("tutorials-page");
            });
        }

        importButton.addEventListener("click", () => 
        {
            const dialog = DialogBox.modal
            (`
                <h1 align="center">Select Parent Deck</h1>
                <div style="padding: 15px; display: flex; flex-direction: column; gap: 20px;">
                <button type="button" class="deck-select"></button>
                <button class="import-button">Choose File</button>
                </div>
            `);

            Deck.configureSearchableSelector(dialog.querySelector(".deck-select"), (deck) => { return true; }, Deck.getRoot(), Deck.getRoot().getId(), "Select parent...");

            dialog.querySelector(".import-button").addEventListener("click", () => 
            { 
                const deck = Deck.getById(dialog.querySelector(".deck-select").value);

                deck.import();
                dialog.close();
            });
        });
    }

    connectedCallback()
    {
        this.innerHTML =
        `

            <div class="options-sidebar-container">
                <button class="import-button">Import</button>
                <button class="tutorial-button">Tutorial</button>
                <button class="about-button">About</button>
                <button class="settings-button">Settings</button>
                <button class="admin-panel-button" hidden>Admin Panel</button>
                <button class="clear-data-button">Clear Local Data</button>
            </div>
        `;

        this.#handleEvents();
        this.#refreshAdminVisibility();

        // Role can change after the sidebar is in the DOM — login/logout
        // and the in-app role-promotion path both fire these events.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () => this.#refreshAdminVisibility());
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () => this.#refreshAdminVisibility());
    }

    #refreshAdminVisibility()
    {
        const adminPanelButton = this.querySelector(".admin-panel-button");
        if (!adminPanelButton)
        {
            return;
        }
        const currentUser = window["user"];
        const isAdmin = !!currentUser && typeof currentUser.getRole === "function" && currentUser.getRole() === userRoles.ADMIN;
        adminPanelButton.hidden = !isAdmin;
    }
}

customElements.define('options-sidebar', OptionsSidebar);
export default OptionsSidebar;