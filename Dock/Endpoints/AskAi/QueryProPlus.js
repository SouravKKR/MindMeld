const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");

/**
 * POST /AskAi/Query/ProPlus
 *
 * Dispatches to the Pro Plus-tier Gemini model — the strongest model
 * available for AskAi. Image input and Google Search grounding are
 * both enabled. Use for math, multi-step proofs, and questions that
 * require deep analysis.
 *
 * Model id and grounding flag come from ModelTierMetadata.PRO_PLUS.
 */
async function handleQueryProPlus(request, response)
{
    await AskAiStreamRunner.run
    ({
        modelId:             ModelTierMetadata.PRO_PLUS.modelId,
        bEnableGoogleSearch: ModelTierMetadata.PRO_PLUS.enableGoogleSearchGrounding,
        request:             request,
        response:            response,
    });
}

module.exports = { handleQueryProPlus };
