import LoginProviderRegistry from "./Classes/LoginProviderRegistry.js";
import GoogleLoginProvider from "./Classes/GoogleLoginProvider.js";
import LegalDocumentDownloader from "./Classes/LegalDocumentDownloader.js";
import ReportIssueDialog from "../../CommonComponents/ReportIssueDialog.js";
import "./Components/EmailOtpForm.js";

/**
 * LoginPage
 *
 * Full-screen gate shown to unauthenticated users at app start. Renders
 * one button per LoginProvider registered with LoginProviderRegistry —
 * clicking a button hands control to that provider's `startLoginFlow`,
 * which redirects to the existing server-side `/Login?provider=...`
 * endpoint. The OAuth callback flow then sets the session cookie and
 * redirects back to origin, which reloads the SPA and re-runs the
 * authentication bootstrap → user lands on home-page.
 *
 * Only Google is registered today; new providers are added by writing a
 * LoginProvider subclass and calling LoginProviderRegistry.register from
 * its own module (or here, alongside the Google registration below).
 */
class LoginPage extends HTMLElement
{
    static
    {
        LoginProviderRegistry.register(new GoogleLoginProvider());
    }

    connectedCallback()
    {
        this.setAttribute("page", "");
        this.#render();
        this.#bindEvents();
    }

    #render()
    {
        const providers = LoginProviderRegistry.getAll();

        const providerButtonsHtml = providers.map((provider, providerIndex) =>
        {
            const escapedDisplayName = provider.getDisplayName().replace(/"/g, "&quot;");
            const iconUrl = provider.getIconUrl();
            const iconHtml = iconUrl
                ? `<img class="login-provider-icon" src="${iconUrl}" alt="">`
                : "";
            return `
                <button class="login-provider-button" data-provider-index="${providerIndex}">
                    ${iconHtml}
                    <span class="login-provider-label">${escapedDisplayName}</span>
                </button>
            `;
        }).join("");

        this.innerHTML =
        `
            <div class="login-page-backdrop">
                <div class="login-page-panel">
                    <img class="login-page-logo"
                         src="./Globals/Assets/Images/Logos/CogniumLearnLogoIcon.png"
                         alt="CogniumLearn">
                    <div class="login-page-title">CogniumLearn</div>
                    <div class="login-page-subtitle">Sign in to continue</div>
                    <div class="login-page-providers">
                        ${providerButtonsHtml}
                    </div>
                    <div class="login-page-divider">
                        <span class="login-page-divider-label">or</span>
                    </div>
                    <email-otp-form></email-otp-form>
                    <div class="login-page-legal">
                        <span>By signing in, you agree to the</span>
                        <a href="#" data-doc="TERMS_OF_SERVICE" class="login-page-legal-link">Terms of Service</a>
                        <span>and</span>
                        <a href="#" data-doc="PRIVACY_POLICY" class="login-page-legal-link">Privacy Policy</a>.
                    </div>
                    <!-- The two things a person can genuinely need before they
                         have a session: reporting that their own work is on the
                         platform, and reporting that they cannot get in. Both
                         are spelled out with the words someone would actually
                         search for rather than hidden behind a generic
                         "support" link. -->
                    <div class="login-page-legal login-page-public-report">
                        <a href="#" data-report-type="INTELLECTUAL_PROPERTY" class="login-page-legal-link">Report copyright / IP infringement</a>
                        <span>·</span>
                        <a href="#" data-report-type="ACCOUNT_ACCESS" class="login-page-legal-link">Can't sign in?</a>
                    </div>
                    <div class="login-page-attribution">
                        <span class="login-page-attribution-label">by</span>
                        <img class="login-page-attribution-logo"
                             src="./Globals/Assets/Images/Logos/CogniumLabsLogo.png"
                             alt="Cognium Labs">
                    </div>
                </div>
                <copyright-notice position="bottom-center"></copyright-notice>
            </div>
        `;
    }

    #bindEvents()
    {
        const providers = LoginProviderRegistry.getAll();

        // Scoped to the provider row on purpose. The email-OTP form reuses the
        // .login-provider-button class for visual consistency, so an unscoped
        // query also matched its submit button — and because that button has no
        // data-provider-index, Number(null) resolved to 0 and every "Continue
        // with email" click started the FIRST provider's flow (Google) instead.
        for (const providerButton of this.querySelectorAll(".login-page-providers .login-provider-button[data-provider-index]"))
        {
            providerButton.addEventListener("click", () =>
            {
                const providerIndex = Number(providerButton.getAttribute("data-provider-index"));
                const provider = Number.isInteger(providerIndex) ? providers[providerIndex] : null;

                if (provider)
                {
                    provider.startLoginFlow();
                }
            });
        }

        for (const legalLink of this.querySelectorAll(".login-page-legal-link"))
        {
            legalLink.addEventListener("click", (clickEvent) =>
            {
                clickEvent.preventDefault();

                const documentKey = legalLink.getAttribute("data-doc");
                if (documentKey)
                {
                    LegalDocumentDownloader.download(documentKey);
                    return;
                }

                const reportTypeName = legalLink.getAttribute("data-report-type");
                if (reportTypeName)
                {
                    ReportIssueDialog.showPublic(reportTypeName);
                }
            });
        }

        this.#openComplaintDialogWhenArrivingFromCopyrightLink();
    }

    /**
     * Opens the complaint form straight away when the visitor arrived at
     * /copyright.
     *
     * That path is the one printed in Clause 19.3 of the Terms of Service and in
     * every acknowledgment email, so somebody following it has already decided
     * what they want to do — landing them on a sign-in screen and asking them to
     * find a link would be a worse answer than the mailto: this replaced.
     *
     * The path is compared case-insensitively because a URL typed off a printed
     * page or a legal document rarely preserves casing, and this is a route
     * people copy by hand.
     */
    #openComplaintDialogWhenArrivingFromCopyrightLink()
    {
        const currentPath = String(window.location?.pathname ?? "").toLowerCase().replace(/\/+$/, "");

        if (currentPath === "/copyright")
        {
            ReportIssueDialog.showPublic("INTELLECTUAL_PROPERTY");
        }
    }
}

customElements.define("login-page", LoginPage);
export default LoginPage;
