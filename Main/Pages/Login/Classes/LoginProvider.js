/**
 * LoginProvider
 *
 * Abstract base for an authentication method shown on the login page.
 * Subclasses describe how a provider appears in the picker (display name,
 * icon) and how its login flow is started. The auth flow on the server
 * side is unchanged — `startLoginFlow` is just expected to redirect the
 * browser to the existing `/Login?provider=...` endpoint, which then
 * runs the provider-specific OAuth handshake.
 *
 * Add a new method (e.g. GitHub, email/password) by extending this class
 * and registering an instance with LoginProviderRegistry — the LoginPage
 * picks up every registered provider automatically.
 */
class LoginProvider
{
    getProviderType()
    {
        throw new Error("LoginProvider.getProviderType must be implemented by the subclass.");
    }

    getDisplayName()
    {
        throw new Error("LoginProvider.getDisplayName must be implemented by the subclass.");
    }

    getIconUrl()
    {
        return "";
    }

    startLoginFlow()
    {
        throw new Error("LoginProvider.startLoginFlow must be implemented by the subclass.");
    }
}

export default LoginProvider;
