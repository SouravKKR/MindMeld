const ChatStrategyRunner = require("./Helpers/ChatStrategyRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /AskAi/Chat/Strategy
 *
 * One cheap planning call for the deck Chat mode, made BEFORE the answer call.
 * Given the user's question it returns { nearestCards, nearestMaterials,
 * expandedQueries } — how much deck content to retrieve and a few non-deviating
 * alternate phrasings to widen the client-side similarity search.
 *
 * Deliberately UNMETERED: it's a tiny flash-lite helper, login-gated, and always
 * returns usable JSON (the runner falls back to safe defaults on any failure).
 * The metered answer call is the separate /AskAi/Query/* stream. The model id is
 * injected server-side (cheapest tier) so the client can't pick a pricier model.
 */
async function handleChatStrategy(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    const body = await request.getBody();
    const userQuery = (body && typeof body.userQuery === "string") ? body.userQuery.trim() : "";

    if (userQuery.length === 0)
    {
        response.sendJson({ nearestCards: 4, nearestMaterials: 3, expandedQueries: [] });
        return;
    }

    const conversation = (body && Array.isArray(body.conversation)) ? body.conversation : null;

    const strategy = await ChatStrategyRunner.run({
        userQuery:    userQuery.slice(0, 2000),
        conversation: conversation,
        modelId:      ModelTierMetadata.BASIC.modelId,
    });

    response.sendJson(strategy);
}

module.exports = { handleChatStrategy };
