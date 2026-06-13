const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /AskAi/Query/Pro
 *
 * Dispatches to the Pro-tier Gemini model. Image input and Google
 * Search grounding are both enabled — Pro is positioned for moderate
 * reasoning questions where a small chain of thought plus fresh web
 * context pays off.
 *
 * Model id and grounding flag come from ModelTierMetadata.PRO.
 *
 * The user is resolved here (not in the runner) so the credit
 * preflight and the post-stream charge are attributed to a concrete
 * userId before any Gemini work starts.
 */
async function handleQueryPro(request, response)
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
        taskType: taskTypes.ASK_AI_PRO,
        userId: user.getId(),
        modelId: ModelTierMetadata.PRO.modelId,
        bEnableGoogleSearch: ModelTierMetadata.PRO.enableGoogleSearchGrounding,
        request: request,
        response: response,
    });
}

module.exports = { handleQueryPro };
