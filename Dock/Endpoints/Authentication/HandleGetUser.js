const { getUser } = require("../Helpers/GetUser");

async function handleGetUser(request, response)
{
    const user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(401);
        return;
    }

    response.statusCode = 200;
    response.sendJson(user.toJson());
}

module.exports = { handleGetUser };