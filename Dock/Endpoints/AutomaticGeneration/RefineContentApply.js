const ContentRefinementRunner = require("./Helpers/ContentRefinementRunner");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /Refine/Content/Apply
 *
 * Writes a revision the user approved, and files the record of it.
 *
 * Refuses with 409 when the passage changed after the proposal was prepared: the
 * write stamps a timestamp that beats any unsynced edit on the user's other
 * devices, so applying against content the proposal never saw would silently
 * destroy work. The client re-requests a proposal instead.
 *
 * Not credit-metered. The model call was charged when the proposal was made, and
 * charging again for the decision would put a price on reviewing carefully.
 */
async function handleRefineContentApply(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    await ContentRefinementRunner.applyProposal
    ({
        userId: user.getId(),
        request: request,
        response: response,
    });
}

module.exports = { handleRefineContentApply };
