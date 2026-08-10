import ReportIssueDialog from "../../CommonComponents/ReportIssueDialog.js";
import InitializationEvents from "../Events/InitializationEvents.js";

/**
 * CopyrightPageBootstrap
 *
 * Opens the copyright / IP complaint form when the app shell was served at
 * /copyright.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * /copyright is printed in Clause 19.3 of the Terms of Service and in every
 * acknowledgment email, which makes it a real address that real people type. The
 * application has no URL router — PageNavigator is an in-memory stack of custom
 * elements and never reads window.location — so without something like this the
 * path would serve the app and then do nothing, and a rightsholder following a
 * link out of a legal document would land on a deck grid.
 *
 * The sign-in shell handles the same path itself (LoginPage), because the two
 * shells are separate bundles and a signed-out visitor never loads this one.
 * Both end at the same dialog.
 *
 * ── Why it waits for initialization, and why it does not wait forever ──────
 *
 * Opening a modal while the full-screen initialization overlay is still up puts
 * the dialog behind it, so the normal path is to wait for the COMPLETE event.
 *
 * The fallback timer is not belt-and-braces. A listener attached at module load
 * misses an event that already fired, and initialization can also fail outright
 * — and the visitor this page exists for is the one least able to work out what
 * went wrong, because they are not a user of the product. A complaint form that
 * appears a moment late is a far better outcome than one that never appears, so
 * after the timeout it opens regardless. #openOnce is idempotent, which is what
 * makes racing the two safe.
 */
class CopyrightPageBootstrap
{
    static #COMPLAINT_PATH = "/copyright";
    static #COMPLAINT_ISSUE_TYPE_NAME = "INTELLECTUAL_PROPERTY";
    static #FALLBACK_DELAY_MILLISECONDS = 6000;

    static #bConsumed = false;

    static
    {
        if (CopyrightPageBootstrap.#isComplaintPath())
        {
            window.addEventListener(InitializationEvents.COMPLETE, () =>
            {
                CopyrightPageBootstrap.#openOnce();
            }, { once: true });

            setTimeout(() =>
            {
                CopyrightPageBootstrap.#openOnce();
            }, CopyrightPageBootstrap.#FALLBACK_DELAY_MILLISECONDS);
        }
    }

    /**
     * Compared case-insensitively and with any trailing slash removed: this is a
     * path people copy off a printed page or out of a legal document, and
     * neither of those preserves casing reliably.
     *
     * @returns {boolean}
     */
    static #isComplaintPath()
    {
        const currentPath = String(window.location?.pathname ?? "").toLowerCase().replace(/\/+$/, "");
        return currentPath === CopyrightPageBootstrap.#COMPLAINT_PATH;
    }

    /**
     * @returns {void}
     */
    static #openOnce()
    {
        if (CopyrightPageBootstrap.#bConsumed)
        {
            return;
        }

        CopyrightPageBootstrap.#bConsumed = true;
        ReportIssueDialog.showPublic(CopyrightPageBootstrap.#COMPLAINT_ISSUE_TYPE_NAME);
    }
}

export default CopyrightPageBootstrap;
