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

    static getAuthenticationUrl(provider)
    {

        console.log(`provider: ${provider}`);
        
        switch(provider)
        {
            case authenticationProviders.GOOGLE:
            {
                return  "https://accounts.google.com/o/oauth2/v2/auth" +
                "?response_type=code" +
                "&client_id=" + App.getClientId(provider) +
                "&redirect_uri=" + encodeURIComponent(App.getRedirectUri(provider)) +
                "&scope=" + encodeURIComponent("openid email profile");
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

}

module.exports = App;