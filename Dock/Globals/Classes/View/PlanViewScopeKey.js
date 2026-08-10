const PlanMetadataConstants = require("../../Constants/PlanMetadataConstants");
const { userRoles } = require("../../Enumerations/UserRoles");
const { planTiers } = require("../../Enumerations/PlanTiers");


/**
 * PlanViewScopeKey
 *
 * The server's half of the plan-sandbox grammar:
 *
 *     plan view   <userId>::plan:<PLAN_TIER_NAME>
 *
 * An administrator looking at "View as Free" is not looking at their own library
 * with some buttons greyed out — they are in a separate NAMESPACE with its own
 * decks, exactly as an organization view is. That is what makes the simulation
 * worth anything: a tier's experience is mostly about what a library looks like
 * when it was built under that tier's limits, and a sandbox that shared the
 * administrator's real decks would answer a question nobody asked.
 *
 * The tier NAME is the key rather than its enum ordinal, so a scope key reads as
 * itself in the database and in a log line, and so renumbering PlanTiers can
 * never silently repoint an existing sandbox at another tier's data. The
 * separator is byte-identical to Main/Globals/Classes/View/ViewIdentity.js,
 * because the two sides must agree on the owner key of every synced row.
 *
 * Kept apart from OrganizationScopeResolver on purpose. That class answers
 * "is this person a member of that institute"; this one belongs to a question
 * about platform staff. Folding the second into a class named for the first
 * would make an organization engine the arbiter of an administrator tool.
 */
class PlanViewScopeKey
{
    static SCOPE_SEPARATOR = "::plan:";

    /**
     * Composes a plan sandbox scope key. An unknown tier name yields the
     * personal key rather than an invented namespace — a malformed claim must
     * never reach storage, because rows written under a namespace no client will
     * ask for again are simply lost.
     *
     * @param {string} userId
     * @param {string} planTierName
     * @returns {string}
     */
    static build(userId, planTierName)
    {
        if (!PlanViewScopeKey.isKnownTierName(planTierName))
        {
            return userId;
        }

        return `${userId}${PlanViewScopeKey.SCOPE_SEPARATOR}${planTierName}`;
    }

    /**
     * True when a scope key names a plan sandbox rather than a personal or
     * organization library.
     */
    static isPlanViewScopeKey(scopeKey)
    {
        return PlanViewScopeKey.extractTierName(scopeKey).length > 0;
    }

    /**
     * The simulated tier a scope key names, or "" for anything else. Validated
     * against the known tier list here rather than by the caller.
     */
    static extractTierName(scopeKey)
    {
        if (typeof scopeKey !== "string")
        {
            return "";
        }

        const separatorIndex = scopeKey.indexOf(PlanViewScopeKey.SCOPE_SEPARATOR);

        if (separatorIndex <= 0)
        {
            return "";
        }

        const planTierName = scopeKey.slice(separatorIndex + PlanViewScopeKey.SCOPE_SEPARATOR.length);

        return PlanViewScopeKey.isKnownTierName(planTierName) ? planTierName : "";
    }

    /**
     * The PlanTiers value a scope key simulates, or null when it names no
     * sandbox.
     */
    static extractTier(scopeKey)
    {
        const planTierName = PlanViewScopeKey.extractTierName(scopeKey);
        return planTierName.length > 0 ? planTiers[planTierName] : null;
    }

    static isKnownTierName(planTierName)
    {
        return typeof planTierName === "string" && PlanMetadataConstants.ORDER.includes(planTierName);
    }

    /**
     * Every sandbox scope key an account can hold — one per tier for an
     * administrator, none for anybody else.
     *
     * Deterministic from the tier list rather than discovered by querying, so
     * storage accounting can include sandboxes without a lookup per assessment.
     * The four keys are returned whether or not their sandboxes have ever been
     * used; measuring an empty namespace costs one indexed query that matches
     * nothing.
     *
     * Storage accounting is the caller that needs this: bytes an administrator
     * parks in a sandbox must still count against their real cap, or four
     * sandboxes would quietly become four times the free allowance.
     *
     * @param {User} user
     * @returns {string[]}
     */
    static listSandboxScopeKeys(user)
    {
        if (!user || typeof user.getRole !== "function" || user.getRole() !== userRoles.ADMIN)
        {
            return [];
        }

        return PlanMetadataConstants.ORDER.map(planTierName => PlanViewScopeKey.build(user.getId(), planTierName));
    }
}

module.exports = PlanViewScopeKey;
