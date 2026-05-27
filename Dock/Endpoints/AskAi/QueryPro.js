const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");

/**
 * POST /AskAi/Query/Pro
 *
 * Dispatches to the Pro-tier Gemini model. Image input and Google
 * Search grounding are both enabled — Pro is positioned for moderate
 * reasoning questions where a small chain of thought plus fresh web
 * context pays off.
 *
 * Model id and grounding flag come from ModelTierMetadata.PRO.
 */
async function handleQueryPro(request, response)
{
    await AskAiStreamRunner.run
    ({
        modelId:             ModelTierMetadata.PRO.modelId,
        bEnableGoogleSearch: ModelTierMetadata.PRO.enableGoogleSearchGrounding,
        request:             request,
        response:            response,
    });
}

module.exports = { handleQueryPro };
