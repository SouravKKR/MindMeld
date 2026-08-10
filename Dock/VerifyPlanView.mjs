/**
 * End-to-end verification harness for the administrator's simulated PLAN VIEW:
 * the storage scope a request resolves to, the entitlement answer inside it, the
 * storage cap it is measured against, and the two things that must NOT be
 * simulated — purchases, and the way out.
 *
 * Run from the Dock directory:
 *     node VerifyPlanView.mjs
 *     VERIFY_PLAN_VIEW_DB=1 node VerifyPlanView.mjs
 *
 *   1. ALWAYS — pure checks that need no database: scope-key composition and the
 *      client/server agreement on its shape, the resolver's authorisation
 *      matrix, the entitlement answer in both directions, the simulated storage
 *      cap, and that every call site and escape hatch exists in the source.
 *
 *   2. DB (opt-in: VERIFY_PLAN_VIEW_DB=1) — drives the real resolvers and the
 *      real storage measurement against MongoDB with prefixed fixtures, and
 *      removes everything it made.
 *
 * The properties worth proving are the ones a careless implementation gets wrong
 * SILENTLY: a forged plan header that is honoured, a simulation that only ever
 * GRANTS (leaving the refusal half — the interesting half — untested), a sandbox
 * that starts over its own cap because it was measured account-wide, a purchase
 * that burns the account's real monthly free-deck perk, and an administrator who
 * cannot get out of a sandbox they entered.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const PlanViewScopeKey = require("./Globals/Classes/View/PlanViewScopeKey");
const ViewScopeResolver = require("./Globals/Classes/View/ViewScopeResolver");
const OrganizationScopeResolver = require("./Globals/Classes/Organization/OrganizationScopeResolver");
const PaidDeckScopeResolver = require("./Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const PlanEntitlementGate = require("./Globals/Classes/Plans/PlanEntitlementGate");
const PlanMetadata = require("./Globals/Classes/Plans/PlanMetadata");
const StorageQuotaEnforcer = require("./Globals/Classes/Storage/StorageQuotaEnforcer");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const User = require("./Globals/Model/User");
const { planTiers } = require("./Globals/Enumerations/PlanTiers");
const { planFeatures } = require("./Globals/Enumerations/PlanFeatures");
const { userRoles } = require("./Globals/Enumerations/UserRoles");
const { userViewKinds } = require("./Globals/Enumerations/UserViewKinds");

let passedCount = 0;
let failedCount = 0;

function assert(bCondition, description)
{
    if (bCondition)
    {
        passedCount += 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount += 1;
        console.log(`  FAIL  ${description}`);
    }
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

function buildUser(role, tier)
{
    return new User({
        id: "plan-view-user",
        role: role,
        additionalData: { plan: tier, email: "plan-view@example.test" },
    });
}

/**
 * A request shaped the way the endpoints see one. `user` is attached because
 * packetron's login plugin attaches it and both scope resolvers read it —
 * without it the resolver falls back to loading the account, which is correct in
 * production and merely means this harness would need a database for checks that
 * are otherwise pure.
 */
function buildRequest(planTierName, organizationId, user = null)
{
    const headers = {};

    if (typeof planTierName === "string" && planTierName.length > 0)
    {
        headers["x-plan-view"] = planTierName;
    }

    if (typeof organizationId === "string" && organizationId.length > 0)
    {
        headers["x-organization-context"] = organizationId;
    }

    return { headers: headers, user: user };
}

function readSource(relativePath)
{
    return fs.readFileSync(path.join(currentDirectory, relativePath), "utf8");
}

function readClientSource(...segments)
{
    return fs.readFileSync(path.join(currentDirectory, "..", "Main", ...segments), "utf8");
}

// ── 1. Scope-key grammar ────────────────────────────────────────────────────

function verifyScopeKeyGrammar()
{
    section("Scope-key grammar");

    assert(PlanViewScopeKey.build("user-1", "PRO") === "user-1::plan:PRO", "A known tier composes a sandbox scope key");
    assert(PlanViewScopeKey.build("user-1", "NOT_A_TIER") === "user-1", "An unknown tier degrades to the personal key rather than inventing a namespace nothing will ever read again");
    assert(PlanViewScopeKey.build("user-1", "") === "user-1", "A blank tier means the personal library");
    assert(PlanViewScopeKey.extractTierName("user-1::plan:PRO_PLUS") === "PRO_PLUS", "The tier round-trips out of a scope key");
    assert(PlanViewScopeKey.extractTierName("user-1::plan:MADE_UP") === "", "A scope key naming an unknown tier reads as no sandbox at all");
    assert(PlanViewScopeKey.extractTier("user-1::plan:FREE") === planTiers.FREE, "FREE resolves to its enum value — zero, which must not be confused with 'no sandbox'");
    assert(PlanViewScopeKey.extractTier("user-1") === null, "A personal key resolves to null rather than to FREE");
    assert(PlanViewScopeKey.isPlanViewScopeKey("user-1::plan:BASIC") === true, "A sandbox key is recognised as one");

    // The two kinds of view must never be mistaken for one another. A plan-
    // scoped licence taking the organization unlock path would dead-end, and an
    // organization key measured as a sandbox would lose its storage grant.
    assert(PlanViewScopeKey.isPlanViewScopeKey("user-1::org:org-9") === false, "An organization key is NOT a sandbox key");
    assert(OrganizationScopeResolver.isOrganizationScopeKey("user-1::plan:PRO") === false, "A sandbox key is NOT an organization key");
    assert(PaidDeckScopeResolver.isOrganizationScopedLicense({ getScopeKey: () => "user-1::plan:PRO" }) !== true, "A sandbox-scoped licence never takes the organization unlock path");

    // The two sides MUST agree byte-for-byte or every sandbox silently orphans.
    // Read from the client source rather than restated here, so the check fails
    // when either side drifts.
    const clientIdentitySource = readClientSource("Globals", "Classes", "View", "ViewIdentity.js");
    const clientSeparatorMatch = clientIdentitySource.match(/static PLAN_SEPARATOR = "(.*?)";/);
    assert(clientSeparatorMatch !== null, "The client declares a plan separator");
    assert(clientSeparatorMatch !== null && `user-1${clientSeparatorMatch[1]}PRO` === PlanViewScopeKey.build("user-1", "PRO"), "The client and server compose the identical sandbox scope key");

    // extractUserId has to be right for EVERY identity, including a malformed
    // one carrying both markers — anything that resolves to a namespace instead
    // of the account would bill, gate and profile the wrong thing.
    const organizationSeparatorMatch = clientIdentitySource.match(/static ORGANIZATION_SEPARATOR = "(.*?)";/);
    assert(organizationSeparatorMatch !== null, "The client declares an organization separator");
    assert(clientIdentitySource.includes("earliestSeparatorIndex"), "The client cuts at the EARLIEST separator, so an identity carrying both markers still resolves to the account");
}

// ── 2. Resolver authorisation matrix ────────────────────────────────────────

async function verifyResolverMatrix()
{
    section("Resolver authorisation matrix");

    const administrator = buildUser(userRoles.ADMIN, planTiers.FREE);
    const ordinaryUser = buildUser(userRoles.USER, planTiers.PRO_PLUS);

    const noClaim = buildRequest(null, null, administrator);
    const noClaimScope = await ViewScopeResolver.resolve(noClaim, "plan-view-user", administrator);
    assert(noClaimScope.scopeKey === "plan-view-user", "No header resolves to the personal library");
    assert(noClaimScope.viewKind === userViewKinds.PERSONAL, "...and reports the personal view kind");
    assert(noClaimScope.bFellBack === false, "...without reporting a rejected claim, because none was made");

    const adminClaim = buildRequest("PRO", null, administrator);
    const adminScope = await ViewScopeResolver.resolve(adminClaim, "plan-view-user", administrator);
    assert(adminScope.scopeKey === "plan-view-user::plan:PRO", "An administrator claiming a valid tier gets that sandbox");
    assert(adminScope.viewKind === userViewKinds.PLAN, "...reported as the plan view kind");
    assert(adminScope.planViewTier === planTiers.PRO, "...carrying the tier the simulation is of");
    assert(ViewScopeResolver.hasRejectedPlanViewClaim(adminClaim, adminScope) === false, "...and is not treated as a rejected claim");

    const lowercaseScope = await ViewScopeResolver.resolve(buildRequest("pro", null, administrator), "plan-view-user", administrator);
    assert(lowercaseScope.scopeKey === "plan-view-user::plan:PRO", "A lower-case tier name is accepted — a client that sent 'pro' meant PRO");

    // The header is a CLAIM. A non-administrator who forges it must get their
    // own library, and the caller must be able to see that it was refused.
    const forgedClaim = buildRequest("PRO", null, ordinaryUser);
    const forgedScope = await ViewScopeResolver.resolve(forgedClaim, "plan-view-user", ordinaryUser);
    assert(forgedScope.scopeKey === "plan-view-user", "A forged plan header falls back to the personal library");
    assert(forgedScope.planViewTierName === "", "...granting no simulation at all");
    assert(ViewScopeResolver.hasRejectedPlanViewClaim(forgedClaim, forgedScope) === true, "...and is reported as a rejected claim, so a sync can refuse rather than merge");

    const unknownClaim = buildRequest("PLATINUM", null, administrator);
    const unknownScope = await ViewScopeResolver.resolve(unknownClaim, "plan-view-user", administrator);
    assert(unknownScope.scopeKey === "plan-view-user", "An unknown tier falls back to the personal library even for an administrator");
    assert(ViewScopeResolver.hasRejectedPlanViewClaim(unknownClaim, unknownScope) === true, "...and is reported, because a malformed claim should not be silently answered from elsewhere");
}

// ── 3. Entitlement, in BOTH directions ──────────────────────────────────────

async function verifyEntitlementSimulation()
{
    section("Entitlement simulation");

    // A simulation that only ever granted would leave the half that matters
    // untested. The whole reason to open the Free view is to see the refusal.
    const freeAdministrator = buildUser(userRoles.ADMIN, planTiers.FREE);
    const grantedUpward = await PlanEntitlementGate.requireFeatureForRequest(
        buildRequest("PRO", null, freeAdministrator), "plan-view-user", planFeatures.AUTOMATIC_GENERATION);

    assert(grantedUpward.allowed === true || grantedUpward.reason === "OK", "A Free administrator inside the Pro view is GRANTED a Pro feature");
    assert(grantedUpward.currentTier === planTiers.PRO, "...and the reported tier is the simulated one, not the real one");
    assert(grantedUpward.planViewTierName === "PRO", "...tagged with the simulation, so a caller can tell the two apart");

    const proPlusAdministrator = buildUser(userRoles.ADMIN, planTiers.PRO_PLUS);
    const refusedDownward = await PlanEntitlementGate.requireFeatureForRequest(
        buildRequest("FREE", null, proPlusAdministrator), "plan-view-user", planFeatures.AUTOMATIC_GENERATION);

    assert(refusedDownward.allowed === false, "An administrator inside the Free view is REFUSED a Pro feature, whatever they really pay for");
    assert(refusedDownward.reason === ErrorCodes.FEATURE_NOT_IN_PLAN, "...with the same refusal a real Free user would get");
    assert(refusedDownward.requiredTier !== null, "...and a real required tier, unlike an organization refusal, because 'upgrade to Pro' is exactly what a Free user is told");
    assert(refusedDownward.currentTier === planTiers.FREE, "...reporting the simulated tier as the current one");

    const alwaysFree = await PlanEntitlementGate.requireFeatureForRequest(
        buildRequest("FREE", null, freeAdministrator), "plan-view-user", planFeatures.ASK_AI);
    assert(alwaysFree.allowed === true, "A feature the Free tier does include is still allowed inside the Free view");

    assert(freeAdministrator.getRole() === userRoles.ADMIN, "The fixture administrator carries the role the simulation is gated on");
}

// ── 4. Storage cap ──────────────────────────────────────────────────────────

async function verifyStorageSimulation()
{
    section("Storage cap simulation");

    const freeCap = await StorageQuotaEnforcer.getLimitBytesForScope("plan-view-user", "plan-view-user::plan:FREE");
    const proPlusCap = await StorageQuotaEnforcer.getLimitBytesForScope("plan-view-user", "plan-view-user::plan:PRO_PLUS");

    assert(freeCap === PlanMetadata.getStorageBytes(planTiers.FREE), "A Free sandbox is capped at exactly the Free allowance");
    assert(proPlusCap === PlanMetadata.getStorageBytes(planTiers.PRO_PLUS), "A Pro Plus sandbox is capped at exactly the Pro Plus allowance");
    assert(freeCap < proPlusCap, "...so the simulated caps actually differ, rather than both falling through to the same default");
    assert(freeCap !== StorageQuotaEnforcer.LIMIT_BYTES, "...and neither is the resolve-failure fallback, which would silently make every simulation 5 GB");

    // No organization grant is added to a sandbox: it is not a member of
    // anything, and a grant leaking in would make the Free view un-fillable.
    const enforcerSource = readSource("Globals/Classes/Storage/StorageQuotaEnforcer.js");
    assert(enforcerSource.includes("PlanViewScopeKey.extractTier(scopeKey)"), "The sandbox cap is read from the scope key rather than from the account's plan");
    assert(enforcerSource.includes("PlanViewScopeKey.isPlanViewScopeKey(scopeKey)\n            ? [scopeKey]"), "A sandbox's usage counts ONLY its own rows, so it behaves like a fresh account at that tier");
    assert(enforcerSource.includes("PlanViewScopeKey.listSandboxScopeKeys(user)"), "...while the account-wide measurement still includes every sandbox, so four of them cannot become four times the allowance");

    // The uploads category has no scope column, so attributing it to a sandbox
    // would either double-count it or fill a simulated Free cap instantly.
    assert(enforcerSource.includes("if (PlanViewScopeKey.isPlanViewScopeKey(scopeKey))\n        {\n            return 0;\n        }"), "Uploads are not attributed to a sandbox, because InformationSource carries no scope");

    const administrator = buildUser(userRoles.ADMIN, planTiers.PRO);
    const ordinaryUser = buildUser(userRoles.USER, planTiers.PRO);
    assert(PlanViewScopeKey.listSandboxScopeKeys(administrator).length === PlanMetadata.getAllTiers().length, "An administrator owns one sandbox per tier");
    assert(PlanViewScopeKey.listSandboxScopeKeys(ordinaryUser).length === 0, "...and nobody else owns any");
    assert(PlanViewScopeKey.listSandboxScopeKeys(null).length === 0, "...including a caller with no user at all");
}

// ── 5. What must NOT be simulated ───────────────────────────────────────────

function verifyRealMoneyIsNotSimulated()
{
    section("Real-money paths are not simulated");

    const purchaseSource = readSource("Endpoints/PaidDeck/InitiatePurchase.js");

    assert(purchaseSource.includes("ErrorCodes.SIMULATED_VIEW_NOT_PURCHASABLE"), "A purchase from inside a simulated view is refused");

    // Refused BEFORE pricing and before any coupon is reserved, so no payment
    // path is reachable at all rather than merely unattractive. The monthly
    // free-deck claim in particular keys on the ACCOUNT, so a simulated Pro Plus
    // view would otherwise hand out genuine marketplace content every month.
    const refusalIndex = purchaseSource.indexOf("SIMULATED_VIEW_NOT_PURCHASABLE");
    const pricingIndex = purchaseSource.indexOf("PaidDeckPricingEngine.computeFinalPrice");
    const claimIndex = purchaseSource.indexOf("useMonthlyFreeDeckClaim");

    assert(refusalIndex > 0 && pricingIndex > 0 && refusalIndex < pricingIndex, "...before the price is computed");
    assert(refusalIndex > 0 && claimIndex > 0 && refusalIndex < claimIndex, "...and before the Pro Plus monthly free-deck claim can be consumed");

    // Credits, subscriptions and payments key on the real account and never come
    // through the request-scoped gate. If one ever did, the simulation would be
    // able to move money.
    const gateSource = readSource("Globals/Classes/Plans/PlanEntitlementGate.js");
    assert(gateSource.includes("#evaluateForPlanView"), "The simulated branch is its own method rather than a condition buried in the organization one");
    assert(!gateSource.includes("CreditLedger") && !gateSource.includes("PlanSubscriptionService"), "The entitlement gate touches no ledger and no subscription service");

    const generateSource = readSource("Endpoints/AutomaticGeneration/Generate.js");
    assert(generateSource.includes("CreditPreflight.check(personalUserId"), "Credits are charged to the real account even inside a sandbox — the plan is simulated, the money is not");

    // ...which is exactly why the switch dialog has to say so.
    const switchDialogSource = readClientSource("Globals", "Classes", "View", "PlanViewSwitchDialog.js");
    assert(switchDialogSource.includes("real credits from your real balance"), "The switch dialog states plainly that credits spent in a sandbox are real");
    assert(switchDialogSource.includes("not bought from"), "...that the marketplace cannot be bought from");
    assert(switchDialogSource.includes("separate, empty library"), "...that the sandbox is a separate library");
    assert(switchDialogSource.includes("including being taken away"), "...and that features can be REMOVED, not only granted");
}

// ── 6. The way out ──────────────────────────────────────────────────────────

function verifyTheWayOut()
{
    section("An administrator can always leave");

    // Four independent exits, because a view replaces the whole library and a
    // user who cannot leave one is stuck in the product, not just in a screen.
    const indicatorSource = readClientSource("CommonComponents", "ViewContextIndicator.js");
    assert(indicatorSource.includes("view-context-indicator-exit"), "1. The always-visible indicator carries an exit button");
    assert(indicatorSource.includes("PlanViewSwitcher.switchToPersonalView"), "...which returns to the personal library");

    const indexSource = readClientSource("index.html");
    assert(indexSource.includes("<view-context-indicator></view-context-indicator>"), "...and it is mounted once at the document level, so it survives every page");

    const profileMenuSource = readClientSource("Pages", "Home", "Components", "ProfileContextMenu.js");
    assert(profileMenuSource.includes("!UserIdentityManager.isPersonalView()"), "2. The profile menu offers 'View as yourself' for ANY non-personal view");
    assert(profileMenuSource.includes("PlanViewSwitcher.switchToPersonalView"), "...routing a plan view to its own switcher");

    // Leaving must never be gated the way entering is: someone using the exit is
    // usually confused or looking at a sandbox that will not render.
    const switcherSource = readClientSource("Globals", "Classes", "View", "PlanViewSwitcher.js");
    const leaveMethodSource = switcherSource.slice(switcherSource.indexOf("static async switchToPersonalView"));
    assert(!leaveMethodSource.includes("confirm"), "3. Leaving a simulation is never confirmed — the exit has nothing to get past");
    assert(!leaveMethodSource.includes("isAvailableToCurrentUser"), "...and is not gated on the role, so a demoted administrator is not trapped");

    const identityManagerSource = readClientSource("Globals", "Classes", "UserIdentityManager.js");
    assert(identityManagerSource.includes("#isPersonalViewForcedByUrl"), "4. `?view=personal` forces the personal library at boot, for when the app will not render at all");
    assert(identityManagerSource.includes("readStoredViewContext"), "...checked inside the stored-view read, so every restore path honours it rather than one call site");

    // A revoked role must collapse the view rather than leave a client pushing a
    // sandbox the server will refuse.
    const authenticationSource = readClientSource("Globals", "Events", "AuthenticationEvents.js");
    assert(authenticationSource.includes("bStillAnAdministrator"), "A stored plan view is restored only while the account is still an administrator");
    assert(authenticationSource.includes("UserIdentityManager.clearViewContext(user.getId())"), "...and collapses to personal on the next refresh when the role is gone");

    // The dangerous half of that: a silent fallback on a sync push would merge a
    // sandbox's decks into the real library, irreversibly.
    const syncSource = readSource("Endpoints/Sync/Sync.js");
    const bulkSnapshotSource = readSource("Endpoints/Sync/BulkSnapshot.js");
    assert(syncSource.includes("hasRejectedPlanViewClaim"), "A sync push REFUSES a rejected plan claim instead of writing the sandbox into the real library");
    assert(syncSource.includes("ErrorCodes.VIEW_NO_LONGER_AVAILABLE"), "...with a code the client can act on");
    assert(bulkSnapshotSource.includes("hasRejectedPlanViewClaim"), "A full snapshot refuses it too, or the client would take the real library to be the sandbox");
}

// ── 7. Call sites ───────────────────────────────────────────────────────────

function verifyCallSites()
{
    section("Every scoped surface resolves the view");

    const scopedFiles =
    [
        ["Endpoints/Sync/Sync.js", "the sync push and pull"],
        ["Endpoints/Sync/BulkSnapshot.js", "the full-resync snapshot"],
        ["Endpoints/Sync/PullLicenses.js", "the licence registry"],
        ["Endpoints/Activity/RecordDailyUsage.js", "daily activity"],
        ["Endpoints/Authentication/HandleGetUser.js", "the storage meter"],
        ["Endpoints/AutomaticGeneration/Generate.js", "generation"],
        ["Globals/Classes/Plans/PlanEntitlementGate.js", "the entitlement gate"],
    ];

    for (const [relativePath, description] of scopedFiles)
    {
        assert(readSource(relativePath).includes("ViewScopeResolver.resolve"), `${description} resolves the active view, not just the organization`);
    }

    // One wrapper, one header. A second fetch wrapper would mean two Request
    // rebuilds per call and an ordering dependency between two module tags.
    const decoratorSource = readClientSource("Globals", "Classes", "View", "ViewContextRequestDecorator.js");
    assert(decoratorSource.includes("X-Plan-View"), "The client stamps the plan view onto same-origin requests");
    assert(decoratorSource.includes("X-Organization-Context"), "...through the same wrapper that stamps the organization context");
    assert(!fs.existsSync(path.join(currentDirectory, "..", "Main", "Globals", "Classes", "Organization", "OrganizationContextRequestDecorator.js")), "...and the organization-only wrapper is gone, so there is exactly one layer over fetch");
    assert(readClientSource("index.html").includes("View/ViewContextRequestDecorator.js"), "...loaded before anything can call fetch");
}

// ── 8. Database tier (opt-in) ───────────────────────────────────────────────

async function verifyAgainstDatabase()
{
    section("Database tier");

    const FIXTURE_USER_ID = "verify-plan-view-fixture-user";
    const SANDBOX_SCOPE_KEY = PlanViewScopeKey.build(FIXTURE_USER_ID, "FREE");

    const database = await DatabaseConnector.getDatabase();
    const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
    const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

    try
    {
        // A real stored account is required, not just an id: the account-wide
        // measurement enumerates sandboxes through PlanViewScopeKey, which
        // answers "none" for anyone who is not an administrator. Without the row
        // this tier would measure the personal scope alone and quietly agree
        // with a build that had lost the union entirely.
        await usersCollection.insertOne
        ({
            id: FIXTURE_USER_ID,
            role: userRoles.ADMIN,
            additionalData: { plan: planTiers.PRO, email: "verify-plan-view@example.test" },
        });

        await decksCollection.insertOne({ userId: FIXTURE_USER_ID, data: { id: "personal-deck", name: "Personal" }, deleted: false });
        await decksCollection.insertOne({ userId: SANDBOX_SCOPE_KEY, data: { id: "sandbox-deck", name: "Sandbox" }, deleted: false });

        StorageQuotaEnforcer.invalidate(FIXTURE_USER_ID);

        const sandboxBreakdown = await StorageQuotaEnforcer.getUsageBreakdownForScope(FIXTURE_USER_ID, SANDBOX_SCOPE_KEY, true);
        const personalBreakdown = await StorageQuotaEnforcer.getUsageBreakdownForScope(FIXTURE_USER_ID, FIXTURE_USER_ID, true);

        assert(sandboxBreakdown.decksBytes > 0, "The sandbox measurement sees the sandbox's own deck");
        assert(sandboxBreakdown.uploadsBytes === 0, "...and attributes no uploads to it");
        assert(personalBreakdown.decksBytes > sandboxBreakdown.decksBytes, "The account-wide measurement sees BOTH decks, so sandbox bytes still count against the real cap");
        assert(sandboxBreakdown.limitBytes === PlanMetadata.getStorageBytes(planTiers.FREE), "The sandbox is measured against the simulated tier's cap");

        // Two libraries, two answers, from one account — the cache must not let
        // one stand in for the other.
        assert(personalBreakdown.decksBytes !== sandboxBreakdown.decksBytes, "The footprint cache keys on the library as well as the account");

        // ...and an ordinary account owns no sandboxes, so demoting the fixture
        // must drop the sandbox's bytes out of the account-wide total again.
        await usersCollection.updateOne({ id: FIXTURE_USER_ID }, { $set: { role: userRoles.USER } });
        StorageQuotaEnforcer.invalidate(FIXTURE_USER_ID);

        const demotedBreakdown = await StorageQuotaEnforcer.getUsageBreakdownForScope(FIXTURE_USER_ID, FIXTURE_USER_ID, true);
        assert(demotedBreakdown.decksBytes < personalBreakdown.decksBytes, "A non-administrator's account-wide total counts no sandboxes, because they own none");
    }
    finally
    {
        await decksCollection.deleteMany({ userId: { $in: [FIXTURE_USER_ID, SANDBOX_SCOPE_KEY] } });
        await usersCollection.deleteMany({ id: FIXTURE_USER_ID });
        StorageQuotaEnforcer.invalidate(FIXTURE_USER_ID);
    }
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main()
{
    console.log("Plan-view verification\n");

    verifyScopeKeyGrammar();
    await verifyResolverMatrix();
    await verifyEntitlementSimulation();
    await verifyStorageSimulation();
    verifyRealMoneyIsNotSimulated();
    verifyTheWayOut();
    verifyCallSites();

    if (process.env.VERIFY_PLAN_VIEW_DB === "1")
    {
        await verifyAgainstDatabase();
    }
    else
    {
        console.log("\n(Database tier skipped — set VERIFY_PLAN_VIEW_DB=1 to run it.)");
    }

    console.log(`\n${passedCount} passed, ${failedCount} failed.`);
    process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((runError) =>
{
    console.error(runError);
    process.exit(1);
});
