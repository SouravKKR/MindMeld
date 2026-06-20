const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleDeviceHeartbeat(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const deviceId = session.getDeviceId();

    if (deviceId)
    {
        await AuthenticationQueryEngine.refreshDeviceHeartbeat(deviceId);
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { handleDeviceHeartbeat };
