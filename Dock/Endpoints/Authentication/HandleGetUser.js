const OrganizationScopeResolver = require("../../Globals/Classes/Organization/OrganizationScopeResolver");
const OrganizationFeatureResolver = require("../../Globals/Classes/Organization/OrganizationFeatureResolver");
const ViewScopeResolver = require("../../Globals/Classes/View/ViewScopeResolver");
const { getUser } = require("../Helpers/GetUser");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const PeriodicCreditReconciler = require("../../Globals/Classes/Credits/PeriodicCreditReconciler");
const PlanReconciler = require("../../Globals/Classes/Plans/PlanReconciler");
const StreakManager = require("../../Globals/Classes/Streak/StreakManager");
const LegalAcceptanceService = require("../../Globals/Classes/Authentication/LegalAcceptanceService");
const AuthenticationQueryEngine = require("../../Globals/Classes/Database/AuthenticationQueryEngine");
const StorageQuotaEnforcer = require("../../Globals/Classes/Storage/StorageQuotaEnforcer");

async function handleGetUser(request, response)
{
    let user = await getUser(request);

    if(!user)
    {
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    // Lazy, pull-based plan reconciliation: persist a lapsed paid plan down to
    // FREE so the stored field agrees with read-time expiry. Fully guarded so a
    // failure never blocks the response; re-fetch when it changed so the
    // response carries the corrected plan.
    try
    {
        const planReconcileResult = await PlanReconciler.reconcile(user.getId());
        if (planReconcileResult.changed)
        {
            const refreshed = await AuthenticationQueryEngine.getUserById(user.getId());
            if (refreshed)
            {
                user = refreshed;
            }
        }
    }
    catch (planReconcileError)
    {
        console.warn(`[HandleGetUser] Plan reconcile failed for ${user.getId()}: ${planReconcileError?.message || planReconcileError}`);
    }

    // Lazy, pull-based enforcement of periodic credit assignments: querying
    // credits is one of the two trigger points (the other is the AI preflight).
    // Any failure here must never block the GetUser response, so it is fully
    // guarded; on a successful grant we re-fetch so the balance is fresh.
    try
    {
        const email = user.getAdditionalData()?.email || "";
        const reconcileResult = await PeriodicCreditReconciler.reconcileForUser(user.getId(), email);
        if (reconcileResult.creditsGranted > 0)
        {
            const refreshed = await AuthenticationQueryEngine.getUserById(user.getId());
            if (refreshed)
            {
                user = refreshed;
            }
        }
    }
    catch (reconcileError)
    {
        console.warn(`[HandleGetUser] Periodic credit reconcile failed for ${user.getId()}: ${reconcileError?.message || reconcileError}`);
    }

    // Login-based daily streak: GetUser fires on every app bootstrap, so this
    // is the "user is active today" trigger. Idempotent per UTC day. Guarded so
    // a streak failure can never block the response; re-fetch when it changed
    // so the response carries the fresh streak + any newly earned badges.
    //
    // Skip while the user still owes legal acceptance: GetUser is deliberately
    // allowlisted through the EnsureLegalAcceptance gate (so login/terms keep
    // working), so advancing the streak here would award it — and possibly a
    // badge — before the user has agreed to the terms. AcceptLegalDocument
    // advances the streak the moment the last document is accepted, so today
    // still counts.
    try
    {
        const owesLegalAcceptance = await LegalAcceptanceService.hasOutstandingAcceptance(user);
        if (!owesLegalAcceptance)
        {
            const streakResult = await StreakManager.recordDailyActivity(user.getId());
            if (streakResult.changed)
            {
                const refreshed = await AuthenticationQueryEngine.getUserById(user.getId());
                if (refreshed)
                {
                    user = refreshed;
                }
            }
        }
    }
    catch (streakError)
    {
        console.warn(`[HandleGetUser] Streak update failed for ${user.getId()}: ${streakError?.message || streakError}`);
    }

    // Attach the live storage picture as a transient sibling of the user JSON
    // (NOT inside additionalData — it is measured, never persisted). GetUser is
    // the channel the client already refreshes for the credit balance, so the
    // Settings storage meter rides the same fetch. The enforcer memoises the
    // measurement for 30s, so bootstrap/refresh bursts don't re-aggregate. A
    // measurement failure must never block the response — omit the field and let
    // the client fall back to its cached/empty state.
    const responseJson = user.toJson();
    try
    {
        // Reported for the library that is actually on screen. Inside a
        // simulated plan sandbox that is the sandbox's own footprint against the
        // simulated tier's cap, so the meter shows an administrator what a user
        // on that plan would see rather than their own real usage.
        const viewScope = await ViewScopeResolver.resolve(request, user.getId(), user);
        responseJson.storageUsage = await StorageQuotaEnforcer.getUsageBreakdownForScope(user.getId(), viewScope.scopeKey);
    }
    catch (storageUsageError)
    {
        console.warn(`[HandleGetUser] Storage usage measurement failed for ${user.getId()}: ${storageUsageError?.message || storageUsageError}`);
        responseJson.storageUsage = null;
    }

    response.statusCode = httpStatus.OK;
    // The organization views this account can switch into, each with what its
    // rules grant the member there. The client renders its "View as" menu and
    // its feature gating from this rather than guessing, and every server
    // endpoint re-checks the same rules anyway — so this is convenience, never
    // the enforcement.
    try
    {
        responseJson.organizationContexts = await buildOrganizationContexts(user);
    }
    catch (organizationContextError)
    {
        console.warn(`[HandleGetUser] Organization context lookup failed for ${user.getId()}: ${organizationContextError?.message || organizationContextError}`);
        responseJson.organizationContexts = [];
    }

    response.sendJson(responseJson);
}

/**
 * Every organization view this account may enter, with the entitlements that
 * apply inside each one.
 *
 * A member of several institutes gets several entries; someone who belongs to
 * none gets an empty list and never sees the switcher at all.
 */
async function buildOrganizationContexts(user)
{
    const scope = await OrganizationScopeResolver.listAllScopeKeysForUser(user);
    const email = user.getAdditionalData()?.email || "";
    const contexts = [];

    for (const organization of scope.organizations)
    {
        const entitlement = await OrganizationFeatureResolver.resolveForMember(organization, user.getId(), email);
        contexts.push
        ({
            organizationId: organization.getId(),
            organizationName: organization.getName(),
            allowedFeatures: entitlement.featureValues,
            storageGrantBytes: entitlement.storageGrantBytes,
            matchedRuleNames: entitlement.matchedRuleNames
        });
    }

    return contexts;
}

module.exports = { handleGetUser };
