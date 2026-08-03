import UserIdentityManager from "./UserIdentityManager.js";

/**
 * DeckCreationChoiceAvailability
 *
 * Single source of truth for the question "does clicking the + tile open
 * the three-way create/import/buy chooser, or does it go straight to the
 * deck editor?".
 *
 * Both branches are real product behaviour: a signed-in, online user gets
 * the chooser (importing and buying both need an account), while an
 * anonymous or offline user is sent directly to the blank deck editor.
 *
 * NewDeckTile uses it to decide what to open. The Beginners tutorial uses
 * it to decide whether its "pick Create a new deck" step applies at all —
 * without that, the tour would sit waiting for a chooser button that a
 * logged-out user never sees.
 */
class DeckCreationChoiceAvailability
{
    /**
     * @returns {boolean} true when the + tile opens CreateDeckChoiceModal.
     */
    static bShouldShowChoiceModal()
    {
        const bLoggedIn = Boolean(window["user"]) && !UserIdentityManager.isAnonymous();
        const bOnline = typeof navigator !== "undefined" ? navigator.onLine !== false : true;

        return bLoggedIn && bOnline;
    }
}

export default DeckCreationChoiceAvailability;
