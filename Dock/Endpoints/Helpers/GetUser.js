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
    const session = request.session || await getSession(request);

    if(!session)
    {
        return null;
    }

    const user = await AuthenticationQueryEngine.getUserById(session.getUserId());

    return user || null;
}

module.exports = { getUser };