import AuthenticationEvents from "../../../Globals/Events/AuthenticationEvents.js";
import TermsAndConditionsManager from "../../../Globals/Classes/TermsAndConditionsManager.js";
import ReportIssueDialog from "../../../CommonComponents/ReportIssueDialog.js";

/**
 * SignInLegalNoticeComponent
 *
 * Standalone bottom-of-screen notice shown only when the user is logged
 * out. Was previously crammed into ProfileComponent's pill, which
 * forced the pill into a tall column layout and threw off the bottom-
 * corner alignment with the sync-status pill. Splitting it out lets:
 *
 *   - the profile pill stay a compact icon+label always pinned to the
 *     same bottom-right anchor as sync-status's bottom-left;
 *   - the legal text live as an independent layer that auto-positions
 *     between the two pills on wide screens and lifts above both on
 *     narrow screens, without shoving either pill out of place.
 *
 * Clicking either hyperlink downloads the corresponding legal document
 * via TermsAndConditionsManager.downloadDocument.
 */
class SignInLegalNoticeComponent extends HTMLElement
{
    refresh()
    {
        if (window["user"])
        {
            this.setAttribute("hidden", "");
        }
        else
        {
            this.removeAttribute("hidden");
        }
    }

    #handleEvents()
    {
        for (const link of this.querySelectorAll(".sign-in-legal-link"))
        {
            link.addEventListener("click", (clickEvent) =>
            {
                clickEvent.preventDefault();

                const documentKey = link.getAttribute("data-doc");
                if (documentKey)
                {
                    TermsAndConditionsManager.downloadDocument(documentKey);
                    return;
                }

                if (link.hasAttribute("data-report-copyright"))
                {
                    ReportIssueDialog.showPublic("INTELLECTUAL_PROPERTY");
                }
            });
        }
    }

    connectedCallback()
    {
        this.innerHTML =
        `
            <span>By logging in, you agree to the</span>
            <a href="#" data-doc="TERMS_OF_SERVICE" class="sign-in-legal-link">Terms of Service</a>
            <span>and</span>
            <a href="#" data-doc="PRIVACY_POLICY" class="sign-in-legal-link">Privacy Policy</a>
            <span>·</span>
            <a href="#" data-report-copyright class="sign-in-legal-link">Report copyright / IP infringement</a>
        `;

        this.#handleEvents();
        this.refresh();

        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_IN, () => this.refresh());
        window.addEventListener(AuthenticationEvents.ON_USER_LOGGED_OUT, () => this.refresh());
    }
}

customElements.define("sign-in-legal-notice-component", SignInLegalNoticeComponent);
export default SignInLegalNoticeComponent;
