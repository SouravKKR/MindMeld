const AskAiStreamRunner = require("./Helpers/AskAiStreamRunner");
const ModelTierMetadata = require("../../Globals/Constants/ModelTierMetadata");

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
 */
async function handleQueryBasic(request, response)
{
    await AskAiStreamRunner.run
    ({
        modelId:             ModelTierMetadata.BASIC.modelId,
        bEnableGoogleSearch: ModelTierMetadata.BASIC.enableGoogleSearchGrounding,
        request:             request,
        response:            response,
    });
}

module.exports = { handleQueryBasic };
