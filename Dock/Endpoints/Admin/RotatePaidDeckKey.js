const KeyManagementService = require("../../Globals/Classes/Security/KeyManagementService");

async function rotatePaidDeckKey(request, response)
{
    if (!KeyManagementService.isReady())
    {
        response.statusCode = 503;
        response.sendJson({ error: "KEY_MANAGEMENT_NOT_READY" });
        return;
    }

    const body = await request.getBody();
    const deckId = body?.deckId;

    if (!deckId)
    {
        response.statusCode = 400;
        response.sendJson({ error: "MISSING_DECK_ID" });
        return;
    }

    const result = await KeyManagementService.rotateKeysForDeck(deckId);

    response.statusCode = result.success ? 200 : 400;
    response.sendJson(result);
}

module.exports = { rotatePaidDeckKey };
