const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /AskAi/Query/Basic
 *
 * Dispatches the selected-text Explain / Ask request to the Basic-tier
 * Gemini model. Image input is supported; Google Search grounding is
 * intentionally OFF on this tier (cheaper, faster, sufficient for the
 * non-reasoning questions the tier is positioned for).
 *
 * Model id and grounding flag come from the codegen-mirrored
 * ModelTierMetadata.BASIC entry — data-driven so a tier swap only
 * needs Common/Constants/ModelTierMetadata.json + setup.bat.
 *
 * The user is resolved here (not in the runner) so the credit
 * preflight and the post-stream charge are attributed to a concrete
 * userId before any Gemini work starts.
 */
async function handleQueryBasic(request, response)
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
        taskType: taskTypes.ASK_AI_BASIC,
        userId: user.getId(),
        modelId: ModelTierMetadata.BASIC.modelId,
        bEnableGoogleSearch: ModelTierMetadata.BASIC.enableGoogleSearchGrounding,
        request: request,
        response: response,
    });
}

module.exports = { handleQueryBasic };
