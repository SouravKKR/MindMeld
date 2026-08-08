const crypto = require("crypto");
const {authenticationProviders }= require("../../Globals/Enumerations/AuthenticationProviders");
const User = require("../../Globals/Model/User");
const UserSession = require("../../Globals/Model/UserSession");
const App = require("../../Globals/Classes/App");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const AccessGate = require("../../Globals/Classes/Authentication/AccessGate");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const UserRoleReconciliator = require("../../Globals/Classes/Authentication/UserRoleReconciliator");
const OrganizationMemberQueryEngine = require("../../Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationAutoAssigner = require("../../Globals/Classes/Organization/OrganizationAutoAssigner");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const PaidDeckDeepLinkCookie = require("../Helpers/PaidDeckDeepLinkCookie");

async function handleLoginCallback(request, response)
{
    const queryParams = await request.getQueryParams();
    const provider = await request.getCookie("provider");

    Logger.log(`[HandleLoginCallback] Callback received from host ${request.headers.host} (provider: ${provider}).`);

    // OAuth login-CSRF / session-fixation guard: the state Google echoed back
    // must equal the single-use token HandleLogin stored in the httpOnly
    // loginState cookie. A missing or mismatched value means this callback was
    // not initiated by this browser's login attempt — reject it before any
    // token exchange or session creation happens.
    const expectedLoginState = await request.getCookie("loginState");
    const receivedLoginState = queryParams["state"];

    if (!isMatchingLoginState(expectedLoginState, receivedLoginState))
    {
        console.warn("[HandleLoginCallback] Rejected callback: login state mismatch.");
        response.clearCookie("loginState");
        response.clearCookie("provider");
        // A rejected callback must not leave a pending deck behind for whoever
        // signs in next on this browser.
        PaidDeckDeepLinkCookie.clear(response);
        response.setHeader("Location", App.getOrigin());
        response.sendStatusCode(httpStatus.FOUND);
        return;
    }

    const code = queryParams["code"];

    let user = null;


    switch(authenticationProviders[provider])
    {
        case authenticationProviders.GOOGLE:
        {
            const parameters = new URLSearchParams(
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
                body: parameters
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
            // The signup credit grant is applied through CreditLedger after
            // the user row exists (see below) so the welcome bonus is
            // admin-configurable and idempotent — not a hardcoded balance.
            const additionalData =
            {
                "displayPicture": userJson.picture,
                "email": normalisedEmail
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

    // Per-environment login allowlist. When enabled (dev / test only), refuse
    // to look up / create the user or mint a session for a disallowed email.
    // Redirect back to the origin with an authError flag the login page can
    // read, mirroring the login-state-mismatch redirect above. Disabled in
    // production, so this short-circuits to allowed for every account.
    const gatedEmail = (user?.getAdditionalData()?.email || "");
    if (!await AccessGate.isEmailAllowed(gatedEmail))
    {
        console.warn("[HandleLoginCallback] Rejected callback: email not on the access allowlist.");
        response.clearCookie("loginState");
        response.clearCookie("provider");
        PaidDeckDeepLinkCookie.clear(response);
        response.setHeader("Location", App.getOrigin() + "?authError=ACCESS_NOT_ALLOWED");
        response.sendStatusCode(httpStatus.FOUND);
        return;
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

    // Whether this is a brand-new account decides if the one-time signup
    // credit grant applies (existing users keep their current balance).
    const bIsNewUser = !existingUser;

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

    // Centralised role reconciliation handles the admin allowlist AND
    // organization-admin promotion in one place. Mutates user.role.
    // Failing closed on a DB hiccup would silently demote a legitimate
    // admin, so we let the exception propagate — login fails loudly
    // rather than silently changing role.
    await UserRoleReconciliator.reconcile(user);

    await AuthenticationQueryEngine.createUser(user);

    // One-time, admin-configurable signup grant. Idempotent on the
    // signup:{userId} reference key, so a replayed login never grants twice.
    if (bIsNewUser)
    {
        try
        {
            const CreditConfigurationStore = require("../../Globals/Classes/Credits/CreditConfigurationStore");
            const CreditLedger = require("../../Globals/Classes/Credits/CreditLedger");
            const { creditTransactionTypes } = require("../../Globals/Enumerations/CreditTransactionTypes");

            const creditConfiguration = await CreditConfigurationStore.load();
            const signupGrantAmount = creditConfiguration.getSignupGrant();
            await CreditLedger.grant(
                user.getId(),
                signupGrantAmount,
                creditTransactionTypes.SIGNUP_GRANT,
                `signup:${user.getId()}`,
                {}
            );

            // Welcome the brand-new user with their starter credits. In-app only
            // — no push token exists this early. Best-effort.
            try
            {
                const NotificationDispatcher = require("../../Globals/Classes/Notifications/NotificationDispatcher");
                const NotificationContent = require("../../Globals/Classes/Notifications/NotificationContent");
                await NotificationDispatcher.dispatch(user.getId(), NotificationContent.signupCreditsGranted(signupGrantAmount), NotificationDispatcher.IN_APP_ONLY);
            }
            catch (welcomeNotifyError)
            {
                console.warn(`[HandleLoginCallback] signup welcome notification failed for ${user.getId()}: ${welcomeNotifyError.message}`);
            }
        }
        catch (signupGrantError)
        {
            console.warn(`[HandleLoginCallback] signup grant failed for ${user.getId()}: ${signupGrantError.message}`);
        }
    }

    // Back-fill the userId on any memberships keyed by this email so
    // downstream queries (e.g. expansion to userId-based joins) work
    // without re-walking the email index. Then mint any pending FREE
    // perks the user is entitled to but doesn't yet have — catches the
    // brief's "if it already exists" case where someone was added as a
    // member before they had an account.
    const targetEmail = (user.getAdditionalData()?.email || "").toLowerCase();
    if (targetEmail.length > 0)
    {
        await OrganizationMemberQueryEngine.backfillUserId(targetEmail, user.getId());
    }
    try
    {
        await OrganizationAutoAssigner.applyFreePerksOnLogin(user);
    }
    catch (autoAssignError)
    {
        console.error(`[HandleLoginCallback] applyFreePerksOnLogin failed for ${user.getId()}: ${autoAssignError.message}`);
    }

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

    try
    {
        const loginAdditionalData = typeof user.getAdditionalData === "function" ? (user.getAdditionalData() || {}) : {};
        Logger.info(logCategory.AUTHENTICATION, LogTitles.LOGIN, "User logged in",
        {
            accountId: user.getId(),
            additionalData: { provider: provider, email: loginAdditionalData.email || "", isNewUser: !existingUser }
        });
    }
    catch (loginLogError)
    {
        // Logging must never break the login flow.
    }

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
    response.clearCookie("loginState");
    response.clearCookie("provider");

    // Resume the paid-deck store page this visitor scanned before signing in.
    // The cookie holds a deck ID and nothing else; the destination is composed
    // from App.getOrigin() inside the helper, so this can never redirect
    // off-origin. No pending deck (the ordinary case) falls back to the origin.
    const pendingPaidDeckId = await PaidDeckDeepLinkCookie.takePendingDeckId(request, response);
    const paidDeckResumeLocation = PaidDeckDeepLinkCookie.buildResumeLocation(pendingPaidDeckId);

    response.setHeader("Location", paidDeckResumeLocation || App.getOrigin());
    response.sendStatusCode(httpStatus.FOUND);

}

/**
 * Constant-time comparison of the echoed OAuth state against the value
 * stored in the loginState cookie. Both must be non-empty and of equal
 * length; the timing-safe compare avoids leaking the expected token via
 * response-time differences.
 */
function isMatchingLoginState(expectedLoginState, receivedLoginState)
{
    if (typeof expectedLoginState !== "string" || expectedLoginState.length === 0)
    {
        return false;
    }

    if (typeof receivedLoginState !== "string" || receivedLoginState.length === 0)
    {
        return false;
    }

    const expectedBuffer = Buffer.from(expectedLoginState, "utf8");
    const receivedBuffer = Buffer.from(receivedLoginState, "utf8");

    if (expectedBuffer.length !== receivedBuffer.length)
    {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

module.exports = { handleLoginCallback };