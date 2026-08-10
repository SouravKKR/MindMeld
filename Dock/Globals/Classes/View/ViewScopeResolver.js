const OrganizationScopeResolver = require("../Organization/OrganizationScopeResolver");
const PlanViewScopeKey = require("./PlanViewScopeKey");
const AuthenticationQueryEngine = require("../Database/AuthenticationQueryEngine");
const { userRoles } = require("../../Enumerations/UserRoles");
const { userViewKinds } = require("../../Enumerations/UserViewKinds");


/**
 * ViewScopeResolver
 *
 * The one question every scoped endpoint asks: which library is this request in?
 *
 * There are three answers — the account's own, an organization's, and an
 * administrator's simulated plan sandbox — and they are separate NAMESPACES
 * rather than one library filtered three ways, so a surface that forgot a
 * predicate cannot leak between them:
 *
 *     personal     <userId>
 *     org view     <userId>::org:<organizationId>
 *     plan view    <userId>::plan:<PLAN_TIER_NAME>
 *
 * Organization is consulted first and wins. The two are mutually exclusive on
 * the client, so a request carrying both headers is malformed, and preferring
 * the claim backed by a real membership over the one backed by a role is the
 * conservative reading of a request that should not exist.
 *
 * This composes OrganizationScopeResolver rather than adding a branch to it,
 * because the two authorisations are different questions — "is this person a
 * member of that institute" and "is this person platform staff" — and folding
 * the second into a class named for the first would make an organization engine
 * the arbiter of an administrator tool.
 *
 * Both claims arrive in HEADERS, and a header is a client claim. Each is
 * re-authorised on every request, and one that does not hold falls back to the
 * personal scope rather than being refused: the honest case for a stale header
 * is a membership that ended or a role that was revoked while a device still had
 * the view open, and that user belongs in their own library.
 *
 * `bFellBack` reports that a claim was made and rejected, because for two
 * callers a silent fallback is DANGEROUS rather than merely surprising. A sync
 * push resolved this way would write the sandbox's decks into the
 * administrator's real library, so Sync and BulkSnapshot refuse instead. Every
 * other caller is a read or a single-scope write where landing in the personal
 * library is exactly right.
 */
class ViewScopeResolver
{
    static PLAN_VIEW_HEADER_NAME = "x-plan-view";

    /**
     * The plan view a request claims, before any authorisation. Upper-cased
     * because the tier names are, and a client that sent "pro" meant PRO.
     */
    static readClaimedPlanTierName(request)
    {
        const headerValue = request?.headers ? request.headers[ViewScopeResolver.PLAN_VIEW_HEADER_NAME] : "";
        return typeof headerValue === "string" ? headerValue.trim().toUpperCase() : "";
    }

    /**
     * Resolves the scope a request should read and write in.
     *
     * The return shape is a SUPERSET of OrganizationScopeResolver.resolve's, so
     * every existing consumer's `const userId = scope.scopeKey;` keeps working
     * unchanged.
     *
     * @param {object} request
     * @param {string} userId the authenticated user
     * @param {User|null} user the loaded user, when the caller already has it
     * @returns {Promise<{scopeKey: string, viewKind: number, organizationId: string|null, organization: Organization|null, planViewTierName: string, planViewTier: number|null, bFellBack: boolean}>}
     */
    static async resolve(request, userId, user = null)
    {
        const organizationScope = await OrganizationScopeResolver.resolve(request, userId);

        if (organizationScope.organizationId !== null)
        {
            return {
                ...organizationScope,
                viewKind: userViewKinds.ORGANIZATION,
                planViewTierName: "",
                planViewTier: null,
                bFellBack: false
            };
        }

        const claimedTierName = ViewScopeResolver.readClaimedPlanTierName(request);

        const personalScope =
        {
            scopeKey: userId,
            viewKind: userViewKinds.PERSONAL,
            organizationId: null,
            organization: null,
            planViewTierName: "",
            planViewTier: null
        };

        if (claimedTierName.length === 0)
        {
            return { ...personalScope, bFellBack: false };
        }

        // Validated against the known tiers BEFORE touching the database. An
        // unrecognised name is a malformed claim rather than an unauthorised
        // one, and it must never reach a scope key — rows written under a
        // namespace no client will ask for again are simply lost.
        if (!PlanViewScopeKey.isKnownTierName(claimedTierName))
        {
            return { ...personalScope, bFellBack: true };
        }

        const resolvedUser = user || request?.user || await AuthenticationQueryEngine.getUserById(userId);

        if (!resolvedUser || typeof resolvedUser.getRole !== "function" || resolvedUser.getRole() !== userRoles.ADMIN)
        {
            return { ...personalScope, bFellBack: true };
        }

        // Logged on acceptance only. A plan view creates no records of its own,
        // so one line per request is the only trail there is of who simulated
        // what — and it is the cheap half, because a rejected claim is already
        // just a request in the personal library.
        console.log(`[ViewScopeResolver] ${userId} is operating inside the simulated ${claimedTierName} plan view.`);

        return {
            scopeKey: PlanViewScopeKey.build(userId, claimedTierName),
            viewKind: userViewKinds.PLAN,
            organizationId: null,
            organization: null,
            planViewTierName: claimedTierName,
            planViewTier: PlanViewScopeKey.extractTier(PlanViewScopeKey.build(userId, claimedTierName)),
            bFellBack: false
        };
    }

    /**
     * True when a request claimed a plan view that did not hold. The signal Sync
     * and BulkSnapshot refuse on — see the class comment.
     */
    static hasRejectedPlanViewClaim(request, scope)
    {
        return scope.bFellBack === true && ViewScopeResolver.readClaimedPlanTierName(request).length > 0;
    }
}

module.exports = ViewScopeResolver;
