const { getUser } = require("../Helpers/GetUser");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");

/**
 * Endpoint: POST /UpdateUserAdditionalData
 *
 * Body: { partialAdditionalData: { ...fieldsToMerge } }
 *
 * Updates the authenticated user's additionalData by merging the supplied
 * partial object on a per-field basis. Returns the resulting additionalData
 * so the client can sync its in-memory User without a follow-up GetUser.
 */
async function handleUpdateUserAdditionalData(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(401);
        return;
    }

    const body = await request.getBody();
    const partialAdditionalData = body?.partialAdditionalData;

    if (!partialAdditionalData || typeof partialAdditionalData !== "object")
    {
        response.sendStatusCode(400);
        return;
    }

    const updatedAdditionalData = await AuthenticationQueryEngine.updateUserAdditionalData(user.getId(), partialAdditionalData);

    if (!updatedAdditionalData)
    {
        response.sendStatusCode(500);
        return;
    }

    response.sendJson({ additionalData: updatedAdditionalData });
}

module.exports = { handleUpdateUserAdditionalData };
