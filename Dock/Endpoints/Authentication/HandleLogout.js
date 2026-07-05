const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const { getSession } = require("../Helpers/GetSession");
const Logger = require("../../Globals/Classes/Logger");
const LogTitles = require("../../Globals/Classes/Logging/LogTitles");
const { logCategory } = require("../../Globals/Enumerations/LogCategory");

async function handleLogout(request, response)
{
    const cookies = await request.getCookies();
    const sessionId = cookies["sessionId"] || "";

    // Capture the account BEFORE the session row is destroyed so the logout event
    // is attributed to a user.
    let userId = "";
    try
    {
        const session = await getSession(request);
        userId = session ? session.getUserId() : "";
    }
    catch (sessionLookupError)
    {
        userId = "";
    }

    await AuthenticationQueryEngine.deleteSession(sessionId);

    Logger.info(logCategory.AUTHENTICATION, LogTitles.LOGOUT, "User logged out", { accountId: userId });

    // The session row is gone, so the cookie is already invalid server-side —
    // clear it client-side too so the browser stops presenting a dead cookie.
    // Attributes mirror the setCookie call in HandleLoginCallback.
    response.clearCookie("sessionId",
    {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax"
    });

    response.statusCode = httpStatus.OK;
    response.end();
}

module.exports = { handleLogout };