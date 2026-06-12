const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");

async function rotatePaidDeckKey(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = httpStatus.SERVICE_UNAVAILABLE;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (!deckId)
    {
        response.statusCode = httpStatus.BAD_REQUEST;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const result = await KeyManagementService.rotateKeysForDeck(deckId);

    response.statusCode = result.success ? 200 : 400;
    response.sendJson(result);
}

module.exports = { rotatePaidDeckKey };
