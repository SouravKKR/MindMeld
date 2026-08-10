import UserIdentityManager from "../UserIdentityManager.js";
import PageNavigator from "../PageNavigator.js";
import PlanViewRegistry from "./PlanViewRegistry.js";
import PlanViewSwitchDialog from "./PlanViewSwitchDialog.js";

/**
 * PlanViewSwitcher
 *
 * Enters and leaves an administrator's simulated plan sandbox.
 *
 * The switch itself is a single call — the identity change is what the rest of
 * the app already reacts to (Deck wipes memory and re-boots from the new
 * namespace, SyncOrchestrator shuts down and re-initialises against it,
 * Persistence re-prefixes every path). What this class adds is the confirmation
 * on the way in and returning the user to a page that still makes sense, since
 * the page they were on may belong to the library that just disappeared.
 *
 * LEAVING IS UNCONDITIONAL AND UNCONFIRMED. switchToPersonalView asks nothing,
 * checks nothing beyond "is there something to leave", and cannot fail on a
 * stale registry the way entering can. Someone using this exit is usually
 * confused, or stuck, or looking at a sandbox that will not render — every guard
 * on that path is one more way to be trapped in a simulation. It is reachable
 * from the indicator on every page and from the profile menu, and if the app
 * fails to render at all there is still `/index.html?view=personal`, which
 * UserIdentityManager honours before it reads the stored view.
 *
 * Kept separate from OrganizationViewSwitcher rather than merged: entering an
 * institute's library and entering a simulation need different guards and say
 * very different things, and the part they share is one line.
 */
class PlanViewSwitcher
{
    /**
     * Enters a simulated plan view after confirming.
     *
     * @param {string} planTierName
     * @returns {Promise<boolean>} whether the view actually changed
     */
    static async switchToPlanView(planTierName)
    {
        if (!PlanViewRegistry.isKnownTierName(planTierName))
        {
            return false;
        }

        if (!PlanViewRegistry.isAvailableToCurrentUser())
        {
            return false;
        }

        if (UserIdentityManager.getPlanViewTierName() === planTierName)
        {
            return false;
        }

        const bConfirmed = await PlanViewSwitchDialog.confirmEnterPlanView(planTierName);
        if (!bConfirmed)
        {
            return false;
        }

        await UserIdentityManager.setPlanViewContext(UserIdentityManager.getUserId(), planTierName);
        PlanViewSwitcher.#returnToHome();
        return true;
    }

    /**
     * Returns to the personal library. No confirmation, no role check — see the
     * class comment. Deliberately tolerant of being called when no plan view is
     * active: an exit that quietly does nothing is better than one that throws.
     *
     * @returns {Promise<boolean>} whether the view actually changed
     */
    static async switchToPersonalView()
    {
        if (!UserIdentityManager.isPlanViewContext())
        {
            return false;
        }

        await UserIdentityManager.clearViewContext(UserIdentityManager.getUserId());
        PlanViewSwitcher.#returnToHome();
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

export default PlanViewSwitcher;
