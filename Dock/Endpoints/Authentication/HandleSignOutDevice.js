const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleSignOutDevice(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const targetDeviceId = body?.deviceId;

    if (!targetDeviceId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DEVICE_ID" });
        return;
    }

    const result = await AuthenticationQueryEngine.signOutDevice
    (
        session.getUserId(),
        targetDeviceId,
        session.getDeviceId()
    );

    if (!result.success)
    {
        response.statusCode = result.reason === "DEVICE_STILL_ACTIVE" ? 409 : 400;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { handleSignOutDevice };
