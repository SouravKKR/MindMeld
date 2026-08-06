import UserIdentityManager from "../UserIdentityManager.js";
import PageNavigator from "../PageNavigator.js";
import OrganizationContextRegistry from "./OrganizationContextRegistry.js";
import OrganizationViewSwitchDialog from "./OrganizationViewSwitchDialog.js";

/**
 * OrganizationViewSwitcher
 *
 * Performs a change of view, once the user has confirmed it.
 *
 * The switch itself is a single call — the identity change is what the rest of
 * the app already reacts to (Deck wipes memory and re-boots from the new
 * namespace, SyncOrchestrator shuts down and re-initialises against it,
 * Persistence re-prefixes every path). What this class adds is the two things
 * that must happen around it: the confirmation, which the specification requires
 * on every switch, and returning the user to a page that still makes sense — the
 * page they were on may belong to the library that just disappeared.
 */
class OrganizationViewSwitcher
{
    /**
     * Enters an organization's view after confirming.
     *
     * @param {string} organizationId
     * @returns {Promise<boolean>} whether the view actually changed
     */
    static async switchToOrganization(organizationId)
    {
        if (OrganizationContextRegistry.findContext(organizationId) === null)
        {
            return false;
        }

        if (UserIdentityManager.getOrganizationContextId() === organizationId)
        {
            return false;
        }

        const bConfirmed = await OrganizationViewSwitchDialog.confirmEnterOrganization(organizationId);
        if (!bConfirmed)
        {
            return false;
        }

        await UserIdentityManager.setOrganizationContext(UserIdentityManager.getUserId(), organizationId);
        OrganizationViewSwitcher.#returnToHome();
        return true;
    }

    /**
     * Returns to the personal library after confirming.
     *
     * @returns {Promise<boolean>} whether the view actually changed
     */
    static async switchToPersonalView()
    {
        if (!UserIdentityManager.isOrganizationContext())
        {
            return false;
        }

        const bConfirmed = await OrganizationViewSwitchDialog.confirmReturnToPersonalView();
        if (!bConfirmed)
        {
            return false;
        }

        await UserIdentityManager.setOrganizationContext(UserIdentityManager.getUserId(), "");
        OrganizationViewSwitcher.#returnToHome();
        return true;
    }

    /**
     * Clears the page stack back to the home page. Every page deeper than home
     * was opened against a deck, a study material or a mock test that belongs to
     * the library being left behind, so leaving them mounted would show entities
     * that no longer exist in memory.
     */
    static #returnToHome()
    {
        PageNavigator.clearAndOpen("home-page");
    }
}

export default OrganizationViewSwitcher;
