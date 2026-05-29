import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import InitializationEvents from "../Events/InitializationEvents.js";
import UserIdentityManager from "./UserIdentityManager.js";
import ReleaseNotesDialog from "../../CommonComponents/ReleaseNotesDialog.js";


/**
 * ReleaseNotesBootstrap
 *
 * Once per session, when both:
 *
 *   - `InitializationEvents.COMPLETE` has fired (Deck tree booted), and
 *   - `AuthenticationEvents.ON_USER_LOGGED_IN` has fired with a
 *     fresh, server-validated session,
 *
 * fetch the release-notes archive, compute the unseen subset against
 * `user.additionalData.lastSeenReleaseNoteVersionSortKey`, and pop the
 * stacked dialog if anything new exists. Dismiss writes the highest
 * visible versionSortKey back to additionalData so subsequent visits
 * skip these notes.
 *
 * Skip conditions:
 *   - Anonymous identity (no per-account pointer to persist).
 *   - SESSION_STATE_STALE_OFFLINE (server data unreachable; popping
 *     stale notes and writing a seen-pointer through a 401 is worse
 *     than waiting until the user is genuinely online).
 *   - `#bAlreadyShownThisSession` — guards against a second
 *     ON_USER_LOGGED_IN firing during the same session lifecycle.
 */
class ReleaseNotesBootstrap
{
    static #bInitializationComplete = false;
    static #bUserLoggedIn = false;
    static #bAlreadyShownThisSession = false;

    static
    {
        console.log("[ReleaseNotesBootstrap] Static initialiser running.");

        window.addEventListener(InitializationEvents.COMPLETE, () =>
        {
            ReleaseNotesBootstrap.#bInitializationComplete = true;
            ReleaseNotesBootstrap.#tryShow();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () =>
        {
            ReleaseNotesBootstrap.#bUserLoggedIn = true;
            ReleaseNotesBootstrap.#tryShow();
        });

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            ReleaseNotesBootstrap.#bUserLoggedIn = false;
            ReleaseNotesBootstrap.#bAlreadyShownThisSession = false;
        });
    }

    static async #tryShow()
    {
        if (!ReleaseNotesBootstrap.#bInitializationComplete) return;
        if (!ReleaseNotesBootstrap.#bUserLoggedIn) return;
        if (ReleaseNotesBootstrap.#bAlreadyShownThisSession) return;

        if (UserIdentityManager.isAnonymous())
        {
            return;
        }

        if (window["sessionState"] !== AuthenticationEvents.SESSION_STATE_FRESH)
        {
            return;
        }

        ReleaseNotesBootstrap.#bAlreadyShownThisSession = true;

        let notes;
        try
        {
            const response = await fetch("/ReleaseNotes/List");
            if (!response.ok)
            {
                return;
            }
            const responseJson = await response.json();
            notes = Array.isArray(responseJson.notes) ? responseJson.notes : [];
        }
        catch (fetchError)
        {
            console.warn("[ReleaseNotesBootstrap] Could not fetch release notes:", fetchError);
            return;
        }

        if (notes.length === 0)
        {
            return;
        }

        const currentUser = window["user"];
        const additionalData = currentUser && typeof currentUser.getAdditionalData === "function"
            ? (currentUser.getAdditionalData() || {})
            : {};
        const rawLastSeen = additionalData.lastSeenReleaseNoteVersionSortKey;
        const lastSeen = Number.isFinite(rawLastSeen) ? rawLastSeen : Number.NEGATIVE_INFINITY;

        const unseenNotes = notes.filter(note => Number(note.versionSortKey) > lastSeen);
        if (unseenNotes.length === 0)
        {
            return;
        }

        const maxSortKey = Number(unseenNotes[0].versionSortKey);

        ReleaseNotesDialog.show(unseenNotes, { markSeenOnClose: true, maxSortKey });
    }
}

export default ReleaseNotesBootstrap;
