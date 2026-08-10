import UserIdentityManager from "../Globals/Classes/UserIdentityManager.js";
import UserIdentityEvents from "../Globals/Events/UserIdentityEvents.js";
import OrganizationContextRegistry from "../Globals/Classes/Organization/OrganizationContextRegistry.js";
import OrganizationViewSwitcher from "../Globals/Classes/Organization/OrganizationViewSwitcher.js";
import PlanViewRegistry from "../Globals/Classes/View/PlanViewRegistry.js";
import PlanViewSwitcher from "../Globals/Classes/View/PlanViewSwitcher.js";

/**
 * ViewContextIndicator
 *
 * Says, permanently and on every page, which library is on screen — and offers
 * one click out of it.
 *
 * A view switch replaces the entire library, and until this existed the only
 * signal was a confirmation dialog dismissed once and a home page that looks
 * empty rather than different. That is survivable for an organization view,
 * where the decks at least belong to somebody. It is not survivable for a
 * simulated plan sandbox, where an administrator can spend REAL credits
 * believing they are inside a simulation of everything.
 *
 * The exit matters as much as the label. The profile menu lives on the home page
 * only, so an administrator three pages deep in a sandbox previously had to
 * navigate back to leave — and if anything on the way failed to render, they had
 * no way out at all. This element is mounted once in index.html, outside the
 * page stack, so it survives whatever the pages are doing. (If even that fails,
 * `/index.html?view=personal` clears the stored view before it is read — see
 * UserIdentityManager.)
 *
 * Mounted once rather than per page because "which library" is a property of the
 * session: the app has more than twenty pages, and a per-page badge would be
 * more than twenty places to forget. It renders nothing at all in the personal
 * view, so a signed-in user in their own library pays one empty element.
 */
class ViewContextIndicator extends HTMLElement
{
    static tagName = "view-context-indicator";

    connectedCallback()
    {
        this.#render();

        // Every switch goes through the identity, so this is the one signal that
        // cannot be missed — including the collapses that happen without anyone
        // clicking anything, such as a revoked role at the next /GetUser.
        window.addEventListener(UserIdentityEvents.CHANGED, () => this.#render());
        window.addEventListener(UserIdentityEvents.READY, () => this.#render());
    }

    #render()
    {
        const planViewTierName = UserIdentityManager.getPlanViewTierName();
        const organizationContextId = UserIdentityManager.getOrganizationContextId();

        if (planViewTierName.length > 0)
        {
            this.#renderBanner("PLAN", `Simulating the ${PlanViewRegistry.getLabel(planViewTierName)} plan`);
            return;
        }

        if (organizationContextId.length > 0)
        {
            this.#renderBanner("ORGANIZATION", `Viewing as ${OrganizationContextRegistry.getOrganizationName(organizationContextId)}`);
            return;
        }

        this.removeAttribute("data-view-kind");
        this.innerHTML = "";
    }

    #renderBanner(viewKindName, labelText)
    {
        this.setAttribute("data-view-kind", viewKindName);

        this.innerHTML = `
            <span class="view-context-indicator-label">${ViewContextIndicator.#escapeHtml(labelText)}</span>
            <button type="button" class="view-context-indicator-exit">Exit</button>
        `;

        this.querySelector(".view-context-indicator-exit").addEventListener("click", async () =>
        {
            // Asked of the switcher that owns the active view rather than
            // branched on here, so leaving a simulation stays unconfirmed while
            // leaving an institute's library keeps its confirmation.
            if (UserIdentityManager.isPlanViewContext())
            {
                await PlanViewSwitcher.switchToPersonalView();
                return;
            }

            await OrganizationViewSwitcher.switchToPersonalView();
        });
    }

    /**
     * Organization names are administrator-supplied text going into innerHTML,
     * so they are escaped rather than trusted.
     */
    static #escapeHtml(value)
    {
        const escapeElement = document.createElement("div");
        escapeElement.textContent = typeof value === "string" ? value : "";
        return escapeElement.innerHTML;
    }
}

customElements.define(ViewContextIndicator.tagName, ViewContextIndicator);

export default ViewContextIndicator;
