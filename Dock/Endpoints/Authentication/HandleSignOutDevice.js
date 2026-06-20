const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const ErrorCodes = require("../../Globals/Constants/ErrorCodes");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function handleSignOutDevice(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const body = await request.getBody();
    const targetDeviceId = body?.deviceId;

    if (!targetDeviceId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: ErrorCodes.MISSING_DEVICE_ID });
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
        response.statusCode = result.reason === ErrorCodes.DEVICE_STILL_ACTIVE ? httpStatus.CONFLICT : httpStatus.BAD_REQUEST;
        response.sendJson({ error: result.reason });
        return;
    }

    response.statusCode = httpStatus.OK;
    response.sendJson({ success: true });
}

module.exports = { handleSignOutDevice };
