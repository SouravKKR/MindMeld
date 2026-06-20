import AuthenticationEvents from "../../../Globals/Events/AuthenticationEvents.js";


/**
 * HomeFooterComponent
 *
 * Two-row footer at the bottom of the Home page:
 *
 *   Top row    — centred middle slot. When logged out this hosts the
 *                Terms of Service / Privacy Policy hyperlinks; when
 *                logged in it hosts the View Activity button. Both
 *                float above the sync / profile pills, just like the
 *                original floating legal notice did.
 *
 *   Bottom row — sync pill anchored bottom-left, profile (or sign-in)
 *                pill anchored bottom-right.
 *
 * Lives in normal document flow (no `position: fixed`), so the deck
 * grid scrolling above it never slides underneath. The sync pill is
 * intentionally omitted from the template when logged out — the sync
 * system has nothing useful to do without a user, and that avoids
 * teaching SyncStatusComponent about authentication state.
 */
class HomeFooterComponent extends HTMLElement
{
    connectedCallback()
    {
        this.refresh();

        this.#boundRefresh = () => this.refresh();
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, this.#boundRefresh);
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, this.#boundRefresh);
    }

    disconnectedCallback()
    {
        if (this.#boundRefresh !== null)
        {
            window.removeEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, this.#boundRefresh);
            window.removeEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, this.#boundRefresh);
        }
    }

    refresh()
    {
        const isLoggedIn = !!window["user"];

        if (isLoggedIn)
        {
            this.innerHTML = `
                <div class="home-footer-top-row">
                    <activity-preview-component></activity-preview-component>
                </div>
                <div class="home-footer-bottom-row">
                    <sync-status-component></sync-status-component>
                    <profile-component></profile-component>
                </div>
            `;
        }
        else
        {
            this.innerHTML = `
                <div class="home-footer-top-row">
                    <sign-in-legal-notice-component></sign-in-legal-notice-component>
                </div>
                <div class="home-footer-bottom-row">
                    <span class="home-footer-bottom-spacer"></span>
                    <profile-component></profile-component>
                </div>
            `;
        }
    }

    #boundRefresh = null;
}

customElements.define("home-footer-component", HomeFooterComponent);
export default HomeFooterComponent;
