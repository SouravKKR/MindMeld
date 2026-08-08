const ContentRefinementQueryEngine = require("../Database/ContentRefinementQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("../Database/SourceLicenceDeclarationQueryEngine");

/**
 * ReferencedProofSourceHashes — the single answer to "which of this user's
 * uploaded documents are being kept as proof of a licensing declaration".
 *
 * There are now two ways a document becomes proof, and both must hold it:
 *
 *   1. It was attached to a CONTENT REFINEMENT as the reference the correction
 *      was made from (contentRefinements.sourceHash).
 *   2. It was declared as a VERIFICATION SOURCE for a paid deck
 *      (sourceLicenceDeclarations.sourceHash).
 *
 * WHY THIS CLASS EXISTS RATHER THAN A SECOND LOOKUP AT EACH CALL SITE. There
 * are two places that can destroy a source — the expiry reaper and the user's
 * own delete endpoint — and both previously asked ContentRefinementQueryEngine
 * directly. Adding a second source of holds by editing both call sites would
 * work exactly until a third caller appears and asks only one of the two
 * engines, at which point the reaper deletes proof while reporting a clean
 * sweep. Holds are the kind of thing that has to be impossible to half-ask.
 *
 * FAILURE IS NOT "NO HOLDS". If either lookup throws, this throws. It does not
 * return the half it managed to load. SourceRetentionPolicy treats a null set
 * as "nothing is held", so a partial answer would read as permission to delete
 * the documents the failed half was protecting — the callers already know to
 * skip a user whose holds could not be resolved, and they can only do that if
 * they are told.
 */
class ReferencedProofSourceHashes
{
    /**
     * Every content hash this user has cited as a licensing basis, from either
     * source of holds.
     *
     * @param {string} userId
     * @return {Promise<Set<string>>}
     * @throws When either underlying lookup fails.
     */
    static async findForUser(userId)
    {
        if (typeof userId !== "string" || userId.length === 0)
        {
            return new Set();
        }

        const [refinementHashes, declarationHashes] = await Promise.all([
            ContentRefinementQueryEngine.findReferencedSourceHashesForUser(userId),
            SourceLicenceDeclarationQueryEngine.findReferencedSourceHashesForUser(userId),
        ]);

        const unionOfHashes = new Set(refinementHashes);

        for (const declarationHash of declarationHashes)
        {
            unionOfHashes.add(declarationHash);
        }

        return unionOfHashes;
    }
}

module.exports = ReferencedProofSourceHashes;
