const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");

async function logScreenshotAttempt(request, response)
{
    const session = request.session;

    if (!session)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const database = await DatabaseConnector.getDatabase();

    await database
        .collection(DatabaseConstants.SCREENSHOT_EVENTS_COLLECTION)
        .insertOne
        ({
            userId: session.getUserId(),
            deviceId: session.getDeviceId(),
            deckId: body?.deckId || null,
            cardId: body?.cardId || null,
            reason: body?.reason || null,
            userAgent: body?.userAgent || null,
            timestamp: new Date()
        });

    response.statusCode = 200;
    response.sendJson({ success: true });
}

module.exports = { logScreenshotAttempt };
