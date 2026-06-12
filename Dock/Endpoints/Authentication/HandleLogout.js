const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleLogout(request, response)
{
    const cookies = await request.getCookies();
    const sessionId = cookies["sessionId"] || "";

    await AuthenticationQueryEngine.deleteSession(sessionId);

    response.statusCode = httpStatus.OK;
    response.end();
}

module.exports = { handleLogout };