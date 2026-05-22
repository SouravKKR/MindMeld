const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

async function getSession(request)
{
    const cookies = await request.getCookies();

    const sessionId = cookies["sessionId"] || "";

    if(!sessionId)
    {
        return null;
    }

    const session = await AuthenticationQueryEngine.getSession(sessionId);

    return session || null;
}

module.exports = { getSession };