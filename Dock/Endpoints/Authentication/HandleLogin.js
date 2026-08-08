const crypto = require("crypto");
const {authenticationProviders} = require("../../Globals/Enumerations/AuthenticationProviders");
const App = require("../../Globals/Classes/App");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const Logger = require("../../Globals/Classes/Logger");

async function handleLogin(request, response)
{
    const queryParams = await request.getQueryParams();
    const provider = queryParams["provider"];

    // Mint a single-use random state token and stash it in an httpOnly cookie.
    // HandleLoginCallback requires the value Google echoes back to match this
    // cookie, so a callback the user's browser didn't initiate is rejected
    // (OAuth login-CSRF / session-fixation guard).
    const loginState = crypto.randomBytes(32).toString("hex");

    const authenticationUrl = App.getAuthenticationUrl(authenticationProviders[provider], loginState);

    // The authentication URL embeds the loginState token (the loginState
    // cookie's value), so it must never be logged — even under --debug.
    Logger.log(`[HandleLogin] Redirecting host ${request.headers.host} to the ${provider} authentication endpoint.`);

    //Redirect to the authentication URL
    response.statusCode = httpStatus.FOUND;
    response.setHeader("Location", authenticationUrl);
    response.setCookie("loginState", loginState,
    {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });
    response.setCookie("provider", provider,
    {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });

    response.end();
}

module.exports = { handleLogin };