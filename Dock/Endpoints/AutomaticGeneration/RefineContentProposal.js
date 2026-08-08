const ContentRefinementRunner = require("./Helpers/ContentRefinementRunner");
const { httpStatus } = require("../../Globals/Enumerations/HttpStatus");
const { getUser } = require("../Helpers/GetUser");

/**
 * POST /Refine/Content/Proposal
 *
 * Asks the model for a revised version of one study material or one side of one
 * flashcard, against a reviewer's instruction and optionally a reference source
 * they have declared a licence for.
 *
 * Returns a PROPOSAL. Nothing is written — the caller compares it against the
 * current content and applies it through /Refine/Content/Apply if they accept.
 *
 * Login-gated and credit-metered; the user is resolved here so the entitlement
 * check and the post-completion charge are attributed to a concrete userId
 * before any model work starts.
 */
async function handleRefineContentProposal(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.statusCode = httpStatus.UNAUTHORIZED;
        response.end("Unauthorised.");
        return;
    }

    await ContentRefinementRunner.proposeContentRevision
    ({
        userId: user.getId(),
        request: request,
        response: response,
    });
}

module.exports = { handleRefineContentProposal };
