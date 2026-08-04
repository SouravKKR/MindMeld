const GenerationProgressSummarizer = require("./GenerationProgressSummarizer");
const { userRoles } = require("../../Enumerations/UserRoles");

/**
 * ProgressVisibilityFilter
 *
 * Decides how much of a generation's progress a given user is allowed to see.
 *
 * The per-task tree is engineering telemetry: it names internal task types,
 * exposes the shape of the pipeline, and invites a user to sit and watch a run
 * that can take hours. A normal user gets the one number that means something to
 * them — how far along the whole thing is — and is told to go and do something
 * else. Administrators keep the full tree, which is what makes it useful for
 * diagnosing a stuck run.
 *
 * The overall roll-up is stamped on for EVERY role, not just the roles that lose
 * the tree. That is deliberate: it leaves exactly one implementation of the
 * roll-up in the product (GenerationProgressSummarizer), so an administrator
 * watching the tree and a user watching the bar can never be shown different
 * percentages for the same run.
 */
class ProgressVisibilityFilter
{
    /**
     * Stamps the overall roll-up onto a built progress tree and, for everyone
     * who is not an administrator, removes the per-task tree.
     *
     * Must run AFTER appendPostPipelineProgress and AFTER the root flags are
     * computed — both of those read the children this may remove.
     *
     * @param {object} progressTree mutated in place
     * @param {object|null} requestingUser the signed-in user, or null
     * @returns {object} the same tree, for call-site convenience
     */
    static apply(progressTree, requestingUser)
    {
        if (!progressTree)
        {
            return progressTree;
        }

        const summary = GenerationProgressSummarizer.summarize(progressTree);
        progressTree.overallCompletion = summary.overallCompletion;
        progressTree.overallStatus = summary.overallStatus;
        progressTree.isTerminal = summary.bTerminal;
        progressTree.failureMessage = summary.failureMessage;

        if (ProgressVisibilityFilter.isAdministrator(requestingUser))
        {
            return progressTree;
        }

        // summaryOnly is what the client keys its "you'll be notified, go and
        // study" view off. An absent children array alone would be ambiguous —
        // a run whose tree genuinely has no children looks the same.
        progressTree.summaryOnly = true;
        delete progressTree.children;

        return progressTree;
    }

    /**
     * Guarded so a malformed or absent user degrades to the restricted view
     * rather than accidentally exposing the tree.
     *
     * @param {object|null} requestingUser
     * @returns {boolean}
     */
    static isAdministrator(requestingUser)
    {
        return !!requestingUser
            && typeof requestingUser.getRole === "function"
            && requestingUser.getRole() === userRoles.ADMIN;
    }
}

module.exports = ProgressVisibilityFilter;
