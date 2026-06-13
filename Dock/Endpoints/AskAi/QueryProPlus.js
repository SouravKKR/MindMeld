const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /AskAi/Query/ProPlus
 *
 * Dispatches to the Pro Plus-tier Gemini model — the strongest model
 * available for AskAi. Image input and Google Search grounding are
 * both enabled. Use for math, multi-step proofs, and questions that
 * require deep analysis.
 *
 * Model id and grounding flag come from ModelTierMetadata.PRO_PLUS.
 *
 * The user is resolved here (not in the runner) so the credit
 * preflight and the post-stream charge are attributed to a concrete
 * userId before any Gemini work starts.
 */
async function handleQueryProPlus(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    await AskAiStreamRunner.run
    ({
        taskType: taskTypes.ASK_AI_PRO_PLUS,
        userId: user.getId(),
        modelId: ModelTierMetadata.PRO_PLUS.modelId,
        bEnableGoogleSearch: ModelTierMetadata.PRO_PLUS.enableGoogleSearchGrounding,
        request: request,
        response: response,
    });
}

module.exports = { handleQueryProPlus };
