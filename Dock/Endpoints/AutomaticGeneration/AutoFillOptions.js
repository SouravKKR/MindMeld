const AutoFillOptionsRunner = require("./Helpers/AutoFillOptionsRunner");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /Generate/AutoFillOptions
 *
 * The "Auto Fill Other Options" generation helper. Takes the user's entered
 * subject / exam / description / additional instructions plus the current
 * generation mode and which artifacts are enabled, asks Gemini (in the Agent)
 * for recommended generation option values, and returns them as a single JSON
 * object the generation page applies to its flashcard / study-material /
 * mock-test settings.
 *
 * Login-gated and credit-metered: the user is resolved here so the credit
 * preflight and the post-completion charge in AutoFillOptionsRunner are
 * attributed to a concrete userId before any Gemini work starts.
 */
async function handleAutoFillOptions(request, response)
{
    const user = await getUser(request);
    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    await AutoFillOptionsRunner.run
    ({
        userId: user.getId(),
        request: request,
        response: response,
    });
}

module.exports = { handleAutoFillOptions };
