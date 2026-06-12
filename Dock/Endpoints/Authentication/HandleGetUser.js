const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleGetUser(request, response)
{
    const user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(401);
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson(user.toJson());
}

module.exports = { handleGetUser };