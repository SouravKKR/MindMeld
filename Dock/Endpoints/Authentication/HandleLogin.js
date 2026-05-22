const PacketronResponse = require("@gamiumgamers/packetron/PacketronResponse");
const {authenticationProviders} = require("../../Globals/Enumerations/AuthenticationProviders");
const App = require("../../Globals/Classes/App");

async function handleLogin(request, response)
{
    const queryParams = await request.getQueryParams();
    const provider = queryParams["provider"];

    const authenticationUrl = App.getAuthenticationUrl(authenticationProviders[provider]);
    
    console.log(`Redirecting to ${authenticationUrl}`);

    //Redirect to the authentication URL
    response.statusCode = 302;
    response.setHeader("Location", authenticationUrl);
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