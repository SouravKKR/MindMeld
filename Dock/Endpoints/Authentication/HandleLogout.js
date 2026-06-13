const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleLogout(request, response)
{
    const cookies = await request.getCookies();
    const sessionId = cookies["sessionId"] || "";

    await AuthenticationQueryEngine.deleteSession(sessionId);

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