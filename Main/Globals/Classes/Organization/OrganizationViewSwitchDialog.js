import DialogBox from "../../../CommonComponents/DialogBox.js";
import UserIdentityManager from "../UserIdentityManager.js";
import OrganizationContextRegistry from "./OrganizationContextRegistry.js";

/**
 * OrganizationViewSwitchDialog
 *
 * Confirms a change of view, every single time, and says plainly what will and
 * will not change.
 *
 * This is not a "are you sure?" speed bump. Switching view replaces the entire
 * library on screen, and someone who does not understand that reads an empty
 * home page as data loss — the decks are still there, in the other view, but
 * nothing on screen says so. The dialog also has to correct the natural but
 * wrong assumption in the other direction: credits, storage and the personal
 * plan follow the PERSON, not the view, so an institute's permissions apply
 * inside its view only and never upgrade or downgrade the private account.
 *
 * Deliberately not suppressible with a "don't show again" — the spec asks for
 * clear instructions on every switch, and the cost of showing it is one click
 * against a whole class of misunderstanding.
 */
class OrganizationViewSwitchDialog
{
    /**
     * Asks the user to confirm entering an organization's view.
     *
     * @param {string} organizationId
     * @returns {Promise<boolean>}
     */
    static async confirmEnterOrganization(organizationId)
    {
        const organizationName = OrganizationContextRegistry.getOrganizationName(organizationId);

        return DialogBox.confirm
        (
            `View as ${OrganizationViewSwitchDialog.#escapeHtml(organizationName)}`,
            OrganizationViewSwitchDialog.#buildEnterMessage(organizationName)
        );
    }

    /**
     * Asks the user to confirm returning to their own library.
     *
     * @returns {Promise<boolean>}
     */
    static async confirmReturnToPersonalView()
    {
        const organizationName = OrganizationContextRegistry.getOrganizationName(UserIdentityManager.getOrganizationContextId());

        return DialogBox.confirm
        (
            "View as yourself",
            OrganizationViewSwitchDialog.#buildLeaveMessage(organizationName)
        );
    }

    static #buildEnterMessage(organizationName)
    {
        const safeName = OrganizationViewSwitchDialog.#escapeHtml(organizationName);

        return `
            <p>You are about to switch to <strong>${safeName}</strong>'s library.</p>
            <ul class="organization-view-switch-list">
                <li>You will see only the decks and study material that belong to ${safeName}. Your own decks stay exactly where they are and come back when you switch to viewing as yourself.</li>
                <li>Which AI features you can use here is decided by ${safeName}, so some things you have on your own account may be unavailable — and some you do not have may be available.</li>
                <li>Your credits and your plan do not change. Credits are yours, spendable in either view, and anything you buy for yourself stays yours.</li>
                <li>Storage used here still counts towards your own storage, together with any extra space ${safeName} has granted you.</li>
                <li>The deck marketplace is part of your own library, so it is not available while you are viewing as ${safeName}.</li>
            </ul>
        `;
    }

    static #buildLeaveMessage(organizationName)
    {
        const safeName = OrganizationViewSwitchDialog.#escapeHtml(organizationName);

        return `
            <p>You are about to switch back to your own library.</p>
            <ul class="organization-view-switch-list">
                <li>${safeName}'s decks will no longer be shown. Nothing is deleted — they are waiting in that view.</li>
                <li>Your own decks, your plan and the marketplace come back.</li>
                <li>Your credits are unaffected; they were never separate.</li>
            </ul>
        `;
    }

    /**
     * Organization names are administrator-supplied text going into an
     * innerHTML dialog, so they are escaped rather than trusted.
     */
    static #escapeHtml(value)
    {
        const escapeElement = document.createElement("div");
        escapeElement.textContent = typeof value === "string" ? value : "";
        return escapeElement.innerHTML;
    }
}

export default OrganizationViewSwitchDialog;
