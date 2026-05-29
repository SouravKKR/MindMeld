import LoginProvider from "./LoginProvider.js";
import { authenticationProviders } from "../../../Globals/Enumerations/AuthenticationProviders.js";

/**
 * GoogleLoginProvider
 *
 * Kicks off the existing server-side OAuth flow by redirecting the
 * browser to `/Login?provider=GOOGLE`. The Dock route handler then
 * issues the Google authorization redirect; once Google bounces the
 * user back to `/Login/Callback`, the session cookie is set and the
 * redirect to origin causes a full reload that re-runs the auth
 * bootstrap. No changes to that server-side flow.
 */
class GoogleLoginProvider extends LoginProvider
{
    static #PROVIDER_QUERY_NAME = "GOOGLE";
    static #ICON_URL = "./Globals/Assets/Images/Logos/GoogleLogo.svg";

    getProviderType()
    {
        return authenticationProviders.GOOGLE;
    }

    getDisplayName()
    {
        return "Continue with Google";
    }

    getIconUrl()
    {
        return GoogleLoginProvider.#ICON_URL;
    }

    startLoginFlow()
    {
        window.location.href = `${window.location.origin}/Login?provider=${GoogleLoginProvider.#PROVIDER_QUERY_NAME}`;
    }
}

export default GoogleLoginProvider;
