const ContentRefinementRunner = require("./Helpers/ContentRefinementRunner");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /Refine/Visual/Proposal
 *
 * Redraws, replaces or removes ONE diagram inside a passage, returning the whole
 * passage with that figure changed.
 *
 * A redraw goes through the deck pipeline's own diagram path, including its
 * vision review, so a refined figure is held to the same standard as a generated
 * one. A removal makes no model call and is not charged.
 *
 * Returns a PROPOSAL. Nothing is written here.
 */
async function handleRefineVisualProposal(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    await ContentRefinementRunner.proposeVisualRevision
    ({
        userId: user.getId(),
        request: request,
        response: response,
    });
}

module.exports = { handleRefineVisualProposal };
