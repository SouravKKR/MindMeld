const crypto = require("crypto");
const PacketronResponse = require("@gamiumgamers/packetron/PacketronResponse");
const {authenticationProviders} = require("../../Globals/Enumerations/AuthenticationProviders");
const App = require("../../Globals/Classes/App");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

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

    console.log(`Redirecting to ${authenticationUrl}`);

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

    console.log(`Setting provider cookie to ${provider}`);
    console.log(`${request.headers.host}`);
    response.end();

    console.log(`Redirected to ${authenticationUrl}`);
}

module.exports = { handleLogin };