import PageNavigator from "../Globals/Classes/PageNavigator.js";
import Deck from "../Globals/Model/Deck.js";
import DialogBox from "./DialogBox.js";
import SearchableDropdown from "./SearchableDropdown.js";
import ReleaseNotesDialog from "./ReleaseNotesDialog.js";
import ReportIssueDialog from "./ReportIssueDialog.js";
import TutorialEngine from "../Globals/Classes/TutorialEngine.js";
import AuthenticationEvents from "../Globals/Events/AuthenticationEvents.js";
import { userRoles } from "../Globals/Enumerations/UserRoles.js";
import Persistence from "../Globals/Classes/Persistence.js";
import Profile from "../Globals/Classes/Profile.js";
import AlertNotifier from "../Pages/AdminPanel/Components/AlertNotifier.js";

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
        const releaseNotesButton = this.querySelector(".release-notes-button");
        const clearDataButton = this.querySelector(".clear-data-button");
        const adminPanelButton = this.querySelector(".admin-panel-button");
        const reportIssueButton = this.querySelector(".report-issue-button");

        document.body.addEventListener("click", () => OptionsSidebar.close());

        if (reportIssueButton)
        {
            reportIssueButton.addEventListener("click", () =>
            {
                ReportIssueDialog.show();
            });
        }

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

        if (releaseNotesButton)
        {
            releaseNotesButton.addEventListener("click", async () =>
            {
                if (!window["user"])
                {
                    await DialogBox.alert("Sign in required", "You must be signed in to view release notes.");
                    return;
                }

                let initialPayload;
                try
                {
                    const response = await fetch("/ReleaseNotes/List");
                    if (!response.ok)
                    {
                        console.error(`[OptionsSidebar] Release notes list failed (HTTP ${response.status}).`);
                        await DialogBox.alert("Release Notes", "Could not load release notes right now. Please try again in a moment.");
                        return;
                    }
                    initialPayload = await response.json();
                }
                catch (fetchError)
                {
                    console.error("[OptionsSidebar] Release notes list failed:", fetchError);
                    await DialogBox.alert("Release Notes", "Could not load release notes right now. Please try again in a moment.");
                    return;
                }

                const notes = Array.isArray(initialPayload?.notes) ? initialPayload.notes : [];
                const availableMajorVersions = Array.isArray(initialPayload?.availableMajorVersions)
                    ? initialPayload.availableMajorVersions
                    : [];
                const selectedMajorVersion = typeof initialPayload?.selectedMajorVersion === "number"
                    ? initialPayload.selectedMajorVersion
                    : null;

                ReleaseNotesDialog.show(notes,
                {
                    markSeenOnClose: false,
                    availableMajorVersions,
                    selectedMajorVersion,
                    onMajorChanged: async (nextMajor) =>
                    {
                        const nextResponse = await fetch(`/ReleaseNotes/List?majorVersion=${encodeURIComponent(nextMajor)}`);
                        if (!nextResponse.ok)
                        {
                            throw new Error(`HTTP ${nextResponse.status}`);
                        }
                        const nextPayload = await nextResponse.json();
                        return Array.isArray(nextPayload?.notes) ? nextPayload.notes : [];
                    }
                });
            });
        }

        if (clearDataButton)
        {
            clearDataButton.addEventListener("click", async () =>
            {
                const confirmed = await DialogBox.confirm
                (
                    "Clear local data?",
                    "This will erase every deck, card, and progress record stored on this device and sign you out. Your data on CogniumLearn's servers is NOT affected — the next sign-in re-syncs everything from the server. This cannot be undone."
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
            PageNavigator.open("cogniumlearn-about-page");
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

        importButton.addEventListener("click", async () =>
        {
            const allDecks = Deck.getAll(() => true, Deck.getRoot());
            const deckItems = allDecks.map(deck => ({
                key:   deck.getId(),
                label: deck.getNameWithAncestors(),
            }));

            const selectedDeckId = await SearchableDropdown.show({
                title:              "Select parent deck",
                searchPlaceholder:  "Search decks...",
                initialKey:         Deck.getRoot().getId(),
                items:              deckItems,
                emptyStateMessage:  "No decks match your search.",
            });

            if (selectedDeckId === null || selectedDeckId === undefined)
            {
                return;
            }

            const parentDeck = Deck.getById(selectedDeckId);
            if (!parentDeck)
            {
                return;
            }

            await parentDeck.import();
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
                <button class="release-notes-button">Release Notes</button>
                <button class="admin-panel-button" hidden>Admin Panel</button>
                <button class="clear-data-button">Clear Local Data</button>
            </div>
            <div class="options-sidebar-contact">
                <span class="options-sidebar-contact-label">Need help?</span>
                <button class="options-sidebar-report-issue report-issue-button">Report an Issue</button>
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

        // The sidebar is part of the always-present chrome, so this is a
        // reliable app-wide place to spin up the operational-alert notifier
        // for admins — it then fires browser notifications (once permission
        // is granted) for any alert raised while the app is open, not only
        // while the Alerts tab is visible. start() is idempotent + gated.
        if (isAdmin)
        {
            AlertNotifier.start();
        }
    }
}

customElements.define('options-sidebar', OptionsSidebar);
export default OptionsSidebar;