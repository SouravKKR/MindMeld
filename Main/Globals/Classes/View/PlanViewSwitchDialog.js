import DialogBox from "../../../CommonComponents/DialogBox.js";
import PlanViewRegistry from "./PlanViewRegistry.js";

/**
 * PlanViewSwitchDialog
 *
 * Confirms ENTERING a simulated plan, and says plainly what is simulated and
 * what is not.
 *
 * Only entering. Leaving a simulation is never confirmed — it is always safe,
 * it is the action someone takes when they are confused or stuck, and putting a
 * dialog in front of it would be a second thing to get past at exactly the wrong
 * moment. The organization switcher confirms both directions because leaving an
 * institute's library changes which real work is on screen; leaving a sandbox
 * changes nothing that matters.
 *
 * The list is ordered by how badly each item would surprise someone who assumed
 * "simulated" meant "nothing here is real". The credits line is first among the
 * warnings because it is the one that costs money: the feature gate runs before
 * the credit preflight and the ledger keys on the real account, so an
 * administrator simulating Pro Plus really can spend their own real credits on
 * image generation their account does not pay for. Faking a balance instead was
 * rejected — it would leave the entire credit path untested, which is the
 * opposite of what a simulation is for.
 */
class PlanViewSwitchDialog
{
    /**
     * Asks the user to confirm entering a simulated plan view.
     *
     * @param {string} planTierName
     * @returns {Promise<boolean>}
     */
    static async confirmEnterPlanView(planTierName)
    {
        const tierLabel = PlanViewRegistry.getLabel(planTierName);

        return DialogBox.confirm
        (
            `View as a ${PlanViewSwitchDialog.#escapeHtml(tierLabel)} user`,
            PlanViewSwitchDialog.#buildEnterMessage(tierLabel)
        );
    }

    static #buildEnterMessage(tierLabel)
    {
        const safeLabel = PlanViewSwitchDialog.#escapeHtml(tierLabel);

        return `
            <p>You are about to use the app as though your account were on the <strong>${safeLabel}</strong> plan.</p>
            <ul class="organization-view-switch-list">
                <li>This is a <strong>separate, empty library</strong>. Your own decks are untouched and come back the moment you switch to viewing as yourself.</li>
                <li>AI features behave as ${safeLabel} — <strong>including being taken away</strong>. On the Free view you will not be able to generate, whatever you actually pay for.</li>
                <li><strong>Credits you spend here are real credits from your real balance.</strong> The plan is simulated; the money is not.</li>
                <li>Storage here is capped at the ${safeLabel} allowance and measured over this sandbox alone — but what you store still counts towards your account's real cap.</li>
                <li>The marketplace can be browsed but <strong>not bought from</strong>. Purchases and the monthly free deck are real transactions.</li>
                <li>Device and session limits are <strong>not</strong> simulated — those stay your real plan's, so simulating Free cannot sign you out of your own devices.</li>
                <li>Files you upload here count against your real account's storage rather than the sandbox meter.</li>
            </ul>
            <p>You can leave at any time from the banner at the top of the screen, or from this menu.</p>
        `;
    }

    /**
     * Tier labels come from a shipped constant rather than from user input, so
     * this is belt and braces — but the dialog is built with innerHTML and every
     * value going into one is escaped here as a rule, not case by case.
     */
    static #escapeHtml(value)
    {
        const escapeElement = document.createElement("div");
        escapeElement.textContent = typeof value === "string" ? value : "";
        return escapeElement.innerHTML;
    }
}

export default PlanViewSwitchDialog;
