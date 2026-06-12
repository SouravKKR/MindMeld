const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const { getSession } = require("./GetSession");
const User = require("../../Globals/Model/User");

/**
 * Retrieves a user from the database using a session obtained from the request.
 * @param {PacketronRequest} request - The request that is being processed.
 * @return {Promise<User | null>} A promise that resolves to the user if found, null otherwise.
 * @async
 */
async function getUser(request)
{
    // Memoize on the request. The legal-acceptance gate, EnsureAdmin/EnsureLogin,
    // and the handler itself can each resolve the user within one request, so a
    // single cached lookup keeps it to one DB round-trip.
    if(request.__userResolved)
    {
        return request.__user;
    }

    const session = request.session || await getSession(request);

    let user = null;
    if(session)
    {
        user = (await AuthenticationQueryEngine.getUserById(session.getUserId())) || null;
    }

    request.__user = user;
    request.__userResolved = true;

    return user;
}

module.exports = { getUser };