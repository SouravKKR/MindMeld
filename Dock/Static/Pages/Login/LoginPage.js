import LoginProviderRegistry from "./Classes/LoginProviderRegistry.js";
import GoogleLoginProvider from "./Classes/GoogleLoginProvider.js";
import LegalDocumentDownloader from "./Classes/LegalDocumentDownloader.js";
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
                         src="./Globals/Assets/Images/Logos/CogniumLabsLogo.png"
                         alt="Cognium Labs">
                    <div class="login-page-title">MindMeld</div>
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
                </div>
                <copyright-notice position="bottom-center"></copyright-notice>
            </div>
        `;
    }

    #bindEvents()
    {
        const providers = LoginProviderRegistry.getAll();

        for (const providerButton of this.querySelectorAll(".login-provider-button"))
        {
            providerButton.addEventListener("click", () =>
            {
                const providerIndex = Number(providerButton.getAttribute("data-provider-index"));
                const provider = providers[providerIndex];

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
                }
            });
        }
    }
}

customElements.define("login-page", LoginPage);
export default LoginPage;
