import AuthenticationEvents from "../Events/AuthenticationEvents.js";
import UserIdentityManager from "./UserIdentityManager.js";
import ReleaseNotesDialog from "../../CommonComponents/ReleaseNotesDialog.js";


/**
 * ReleaseNotesBootstrap
 *
 * Final step of `LoginPopupSequence`. By the time this runs the user
 * has already accepted the legal docs, finished (or skipped) the
 * Beginners tutorial, and answered the local-AI-model-download prompt
 * (if their device was eligible), so the release-notes archive can
 * surface without piling on top of anything else.
 *
 * Fetches the release-notes archive, computes the unseen subset against
 * `user.additionalData.lastSeenReleaseNoteVersionSortKey`, and pops the
 * stacked dialog if anything new exists. Dismiss writes the highest
 * visible versionSortKey back to additionalData so subsequent visits
 * skip these notes.
 *
 * Skip conditions:
 *   - Anonymous identity (no per-account pointer to persist).
 *   - SESSION_STATE_STALE_OFFLINE (server data unreachable; popping
 *     stale notes and writing a seen-pointer through a 401 is worse
 *     than waiting until the user is genuinely online).
 *   - `#bAlreadyShownThisSession` — guards against a second invocation
 *     during the same session lifecycle.
 */
class ReleaseNotesBootstrap
{
    static #bAlreadyShownThisSession = false;

    static
    {
        // Reset the session-once guard on logout so re-login within the
        // same page lifecycle can re-show the dialog if that user has
        // an older lastSeenReleaseNoteVersionSortKey than this account.
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () =>
        {
            ReleaseNotesBootstrap.#bAlreadyShownThisSession = false;
        });
    }

    /**
     * Public entry point invoked by LoginPopupSequence. Resolves once
     * the dialog has been enqueued (or the step is skipped). Returns
     * before the dialog is actually dismissed — there's no step after
     * this one, and the dialog has its own close button.
     */
    static async runForLogin(user)
    {
        if (!user)
        {
            return;
        }

        if (ReleaseNotesBootstrap.#bAlreadyShownThisSession)
        {
            return;
        }

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

        const additionalData = typeof user.getAdditionalData === "function"
            ? (user.getAdditionalData() || {})
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
