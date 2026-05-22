const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

async function handleDeviceHeartbeat(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const deviceId = session.getDeviceId();

    if (deviceId)
    {
        await AuthenticationQueryEngine.refreshDeviceHeartbeat(deviceId);
    }

    response.statusCode = 200;
    response.sendJson({ success: true });
}

module.exports = { handleDeviceHeartbeat };
