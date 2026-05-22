const { PacketronRequest, PacketronResponse } = require("@gamiumgamers/packetron");
const GenerationTemplateQueryEngine = require("../../Globals/Classes/Database/GenerationTemplateQueryEngine");
const { getUser } = require("../Helpers/GetUser");


/**
 * GET /Templates/Get?key=<TEMPLATE_KEY>
 *
 * Returns the full template document (displayName, tagline, generalPatch,
 * flashcardPatch, studyMaterialPatch, mockTestPatch, additionalInformationSources)
 * for a single template key. Called after the user picks a card in the
 * picker dialog; the dialog itself only carries the lightweight card
 * payload from /Templates/Search.
 *
 * Scope-checked: a 404 is returned if a template with this key exists
 * but is owned by another user.
 *
 * Returns 400 if `key` is missing, 401 if unauthenticated, 404 if no
 * accessible template matches.
 *
 * @param {PacketronRequest} request
 * @param {PacketronResponse} response
 */
async function handleTemplatesGet(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.sendStatusCode(401);
        return;
    }

    const queryParameters = await request.getQueryParams();
    const templateKey = queryParameters.key;

    if (!templateKey || typeof templateKey !== "string")
    {
        response.statusCode = 400;
        response.end("Missing `key` query parameter.");
        return;
    }

    const templateDocument = await GenerationTemplateQueryEngine.getByKey(user.getId(), templateKey);

    if (templateDocument === null)
    {
        response.statusCode = 404;
        response.end(`No template found with key "${templateKey}".`);
        return;
    }

    response.sendJson(templateDocument);
}

module.exports = { handleTemplatesGet };
