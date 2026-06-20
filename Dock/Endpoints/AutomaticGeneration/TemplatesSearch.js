const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const GenerationTemplateQueryEngine = require("../../Globals/Classes/Database/GenerationTemplateQueryEngine");
const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");


/**
 * GET /Templates/Search?query=<text>&limit=<n>
 *
 * Returns a card list (minimal payload — key, displayName, tagline) for
 * the template picker. When `query` is empty or absent, returns the top
 * `limit` templates sorted by displayName. Otherwise runs a case-insensitive
 * substring match over displayName + tagline.
 *
 * Results are scoped to globals plus the calling user's own templates;
 * templates owned by another user are filtered out.
 *
 * Auth-gated — generation requires a user session, and templates are
 * only useful in that context.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleTemplatesSearch(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const queryParameters = await request.getQueryParams();
    const searchQuery = queryParameters.query || "";
    const limitParameter = queryParameters.limit;

    const cards = await GenerationTemplateQueryEngine.searchCards(user.getId(), searchQuery, limitParameter);

    response.sendJson(cards);
}

module.exports = { handleTemplatesSearch };
