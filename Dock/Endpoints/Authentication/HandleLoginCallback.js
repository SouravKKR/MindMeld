const PacketronResponse = require("@gamiumgamers/packetron/PacketronResponse");
const {authenticationProviders }= require("../../Globals/Enumerations/AuthenticationProviders");
const { userRoles } = require("../../Globals/Enumerations/UserRoles");
const User = require("../../Globals/Model/User");
const UserSession = require("../../Globals/Model/UserSession");
const App = require("../../Globals/Classes/App");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const AdminEmailQueryEngine = require("../../Globals/Classes/Database/AdminEmailQueryEngine");

async function handleLoginCallback(request, response)
{
    const queryParams = await request.getQueryParams();
    const provider = await request.getCookie("provider");

    console.log(`${request.headers.host}`);
    
    console.log(await request.getCookies());

    console.log(`provider: ${provider}`);
    const code = queryParams["code"];
    
    let user = null;


    switch(authenticationProviders[provider])
    {
        case authenticationProviders.GOOGLE:
        {
            const params = new URLSearchParams(
            {
                code,
                client_id: App.getClientId(authenticationProviders.GOOGLE),
                client_secret: App.getClientSecret(authenticationProviders.GOOGLE),
                redirect_uri: App.getRedirectUri(authenticationProviders.GOOGLE),
                grant_type: "authorization_code"
            });

            const tokenResponse = await fetch("https://oauth2.googleapis.com/token",
            {
                method: "POST",
                headers:
                {
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: params
            });

            const tokenData = await tokenResponse.json();

            const userResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo",
            {
                headers:
                {
                    "Authorization": "Bearer " + tokenData.access_token
                }
            });

            const userJson = await userResponse.json();
            const normalisedEmail = typeof userJson.email === "string" ? userJson.email.trim().toLowerCase() : "";
            const additionalData =
            {
                "displayPicture": userJson.picture,
                "email": normalisedEmail,
                "credits": 5
            }

            // Join date will be obtained from the database later on... defaulted to now
            user = new User
            ({
                id: userJson.sub,
                displayName: userJson.name,
                provider:authenticationProviders.GOOGLE,
                joinDate: new Date(),
                preferences:{},
                additionalData: additionalData
            });

            break;

        }

    }

    // Look up by Google sub first; if absent, fall back to email match so
    // a user who first signed up via email-OTP lands on the same record
    // when they later use Google with the same address. Keeps "one
    // identity per email" symmetric across both providers.
    let existingUser = await AuthenticationQueryEngine.getUserById(user?.getId() || "");
    if (!existingUser && user?.getAdditionalData()?.email)
    {
        existingUser = await AuthenticationQueryEngine.getUserByEmail(user.getAdditionalData().email);
        if (existingUser)
        {
            user.setId(existingUser.getId());
        }
    }

    if(existingUser)
    {
        const freshData = user.getAdditionalData();
        const storedData = existingUser.getAdditionalData() ?? {};

        existingUser.setAdditionalData({
            ...storedData,
            displayPicture: freshData.displayPicture,
            email: freshData.email
        });
        existingUser.setDisplayName(user.getDisplayName());

        user = existingUser;
    }

    // Reconcile the admin allowlist against the User document on every
    // login. The seed file + admin-panel Admins tab manage the
    // allowlist; this is where it actually takes effect on user.role.
    // Failing closed (treat allowlist as not containing the email) if
    // the DB call throws would silently demote a legitimate admin on a
    // transient error, so we let the exception propagate — the login
    // should fail loudly rather than silently change role.
    const targetEmail = (user.getAdditionalData()?.email || "").toLowerCase();
    if (targetEmail.length > 0 && await AdminEmailQueryEngine.isAdminEmail(targetEmail))
    {
        if (user.getRole() !== userRoles.ADMIN)
        {
            user.setRole(userRoles.ADMIN);
        }
    }
    else if (user.getRole() === userRoles.ADMIN)
    {
        user.setRole(userRoles.USER);
    }

    await AuthenticationQueryEngine.createUser(user);

    // Seed a per-user sync-data row at timestamp 0 so the syncData
    // collection always carries a record for this user, even before
    // their first device syncs. Idempotent — `upsertSyncData` is upsert
    // semantics, so returning users with an existing record at a real
    // timestamp are NOT reset (the device-keyed query won't match the
    // sentinel "" device row vs their actual device id).
    if (!existingUser)
    {
        try
        {
            await SyncQueryEngine.upsertSyncData(user.getId(), "", 0);
        }
        catch (syncSeedError)
        {
            console.error(`[HandleLoginCallback] Failed to seed syncData row for ${user.getId()}: ${syncSeedError.message}`);
        }
    }

    const session = await AuthenticationQueryEngine.createSession(user.getId(), authenticationProviders[provider]);

    // Without an explicit Max-Age the browser treats the cookie as
    // session-only and wipes it the next time the webview / browser
    // restarts — which on Tauri happens every time the dock server
    // restarts. Pin the cookie lifetime to the session row's TTL so
    // the browser keeps the cookie for as long as the server-side
    // row is valid.
    const sessionLifetimeSeconds = Math.floor(UserSession.getExpirationTime() / 1000);

    response.setCookie("sessionId", session.getId(),
    {
        maxAge: sessionLifetimeSeconds,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });
    response.clearCookie("provider");
    
    response.setHeader("Location", App.getOrigin());
    response.sendStatusCode(302);
  
}

module.exports = { handleLoginCallback };