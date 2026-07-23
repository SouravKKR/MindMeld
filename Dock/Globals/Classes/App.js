const {authenticationProviders} = require("../Enumerations/AuthenticationProviders");

class App
{
    static isDebug()
    {
        return process.argv.includes("--debug");
    }

    static getOrigin()
    {
        const domainName = process.env.DOMAIN_NAME || "";

        if(!domainName || App.isDebug())
        {
            return `http://127.0.0.1:3000`;
        }

        return `https://${domainName}`;
    }

    static getClientId(provider)
    {
        switch(provider)
        {
            case authenticationProviders.GOOGLE:
            {
                return process.env.GOOGLE_CLIENT_ID;
            }
        }

        return "";
    }

    static getClientSecret(provider)
    {
        switch(provider)
        {
            case authenticationProviders.GOOGLE:
            {
                return process.env.GOOGLE_CLIENT_SECRET;
            }
        }

        return "";
    }
    static getRedirectUri(provider)
    {
        switch(provider)
        {
            case authenticationProviders.GOOGLE:
            {
                return App.getOrigin() + "/Login/Callback";
            }
        }

        return "";
    }

    static getAuthenticationUrl(provider, state)
    {

        console.log(`provider: ${provider}`);

        // `state` is an opaque, single-use random token minted by HandleLogin and
        // stored in an httpOnly cookie. Google echoes it back to the callback,
        // where it must match the cookie — this binds the callback to the browser
        // that started the flow and defeats OAuth login-CSRF / session fixation.
        const stateParameter = typeof state === "string" ? state : "";

        switch(provider)
        {
            case authenticationProviders.GOOGLE:
            {
                return  "https://accounts.google.com/o/oauth2/v2/auth" +
                "?response_type=code" +
                "&client_id=" + App.getClientId(provider) +
                "&redirect_uri=" + encodeURIComponent(App.getRedirectUri(provider)) +
                "&scope=" + encodeURIComponent("openid email profile") +
                "&state=" + encodeURIComponent(stateParameter);
            }
        }
    }

    static getDatabaseUrl()
    {
        return process.env.MONGODB_URL;
    }

    static getDatabaseName()
    {
        return process.env.MONGODB_DATABASE_NAME;
    }

    static getSmtpHost()
    {
        return process.env.SMTP_HOST || "";
    }

    static getSmtpPort()
    {
        const parsedPort = Number(process.env.SMTP_PORT);
        return Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 0;
    }

    static getSmtpUser()
    {
        return process.env.SMTP_USER || "";
    }

    static getSmtpPassword()
    {
        return process.env.SMTP_PASSWORD || "";
    }

    static getSmtpSourceEmail()
    {
        return process.env.SMTP_SOURCE_EMAIL || "";
    }

    /**
     * The provider-neutral "from" address every outbound email uses. Prefers
     * the dedicated EMAIL_SOURCE_EMAIL and falls back to the legacy
     * SMTP_SOURCE_EMAIL so existing deployments keep working. With SES this
     * must be a verified SES identity (email or domain).
     */
    static getEmailSourceEmail()
    {
        return process.env.EMAIL_SOURCE_EMAIL || process.env.SMTP_SOURCE_EMAIL || "";
    }

    static getSesRegion()
    {
        return process.env.SES_REGION || "";
    }

    static getSesAccessKeyId()
    {
        return process.env.SES_ACCESS_KEY_ID || "";
    }

    static getSesSecretAccessKey()
    {
        return process.env.SES_SECRET_ACCESS_KEY || "";
    }

    // ── Firebase Cloud Messaging (push notifications) ────────────────────────
    // A Firebase service account authorises the backend to send FCM pushes to
    // web / Android / iOS devices. The three cert() fields come from the
    // downloaded service-account JSON. FIREBASE_VAPID_KEY is the Web Push
    // public key the browser client needs to obtain an FCM token. All are
    // env-then-GSM placeholders (same pattern as the SES creds).
    static getFirebaseProjectId()
    {
        return process.env.FIREBASE_PROJECT_ID || "";
    }

    static getFirebaseClientEmail()
    {
        return process.env.FIREBASE_CLIENT_EMAIL || "";
    }

    static getFirebasePrivateKey()
    {
        // Private keys are stored in env as a single line with literal "\n"
        // escape sequences; restore the real newlines cert() expects.
        return (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    }

    static getFirebaseVapidKey()
    {
        return process.env.FIREBASE_VAPID_KEY || "";
    }

    static getRazorpayWebhookSecret()
    {
        return process.env.RAZORPAY_WEBHOOK_SECRET || "";
    }

    /**
     * Whether the per-environment login allowlist is active. When OFF
     * (production — the default), everyone may log in exactly as before.
     * When ON (dev / test only), only allowed emails may sign in. Read as
     * a trimmed, lowercased truthy flag ("1" / "true" / "yes").
     */
    static isAccessAllowlistEnabled()
    {
        const rawValue = (process.env.ACCESS_ALLOWLIST_ENABLED || "").trim().toLowerCase();
        return rawValue === "1" || rawValue === "true" || rawValue === "yes";
    }

    /**
     * The env-configured root login allowlist: ACCESS_ALLOWLIST_EMAILS is a
     * comma-separated list. Each entry is trimmed and lowercased, empties are
     * dropped, and the resulting array is returned.
     */
    static getAccessAllowlistEmails()
    {
        const rawValue = process.env.ACCESS_ALLOWLIST_EMAILS || "";
        return rawValue
            .split(",")
            .map(entry => entry.trim().toLowerCase())
            .filter(entry => entry.length > 0);
    }

}

module.exports = App;