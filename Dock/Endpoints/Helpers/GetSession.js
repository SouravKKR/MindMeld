const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

async function getSession(request)
{
    // Memoize the lookup on the request. Several plugins resolve the session
    // per request (the rate-limit plugin, then EnsureLogin / EnsureAdmin, then
    // the handler), so caching the result keeps it to a single DB round-trip.
    if(request.__sessionResolved)
    {
        return request.__session;
    }

    const cookies = await request.getCookies();

    const sessionId = cookies["sessionId"] || "";

    let session = null;

    if(sessionId)
    {
        session = (await AuthenticationQueryEngine.getSession(sessionId)) || null;
    }

    request.__session = session;
    request.__sessionResolved = true;

    return session;
}

module.exports = { getSession };