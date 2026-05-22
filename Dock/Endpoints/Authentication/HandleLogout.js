const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

async function handleLogout(request, response)
{
    const cookies = await request.getCookies();
    const sessionId = cookies["sessionId"] || "";

    await AuthenticationQueryEngine.deleteSession(sessionId);

    response.statusCode = 200;
    response.end();
}

module.exports = { handleLogout };