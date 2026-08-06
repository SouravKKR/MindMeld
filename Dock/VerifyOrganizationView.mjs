/**
 * End-to-end verification harness for the organization VIEW: the storage scope
 * a request reads and writes in, the permission rules that decide what a member
 * may do inside it, and the storage cap that spans both views.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationView.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationView.mjs
 *
 *   1. ALWAYS — pure checks that need no database: scope-key composition and
 *      the client/server agreement on its shape, licence-scope selection,
 *      permission-rule validation, and that every gate call site and route
 *      exists.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — drives the real resolvers
 *      against MongoDB. The properties worth proving are the ones a careless
 *      implementation gets wrong SILENTLY: a forged context that is honoured, a
 *      rule granting a feature the organization was never sold, a Free-tier
 *      feature an organization managed to withhold, an organization's grant
 *      leaking into the personal view, and a storage meter that counts one
 *      library while the cap covers two.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationScopeResolver = require("./Globals/Classes/Organization/OrganizationScopeResolver");
const OrganizationFeatureResolver = require("./Globals/Classes/Organization/OrganizationFeatureResolver");
const OrganizationPermissionRuleQueryEngine = require("./Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const OrganizationQueryEngine = require("./Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberQueryEngine");
const PaidDeckScopeResolver = require("./Globals/Classes/PaidDeck/PaidDeckScopeResolver");
const PlanEntitlementGate = require("./Globals/Classes/Plans/PlanEntitlementGate");
const PlanMetadata = require("./Globals/Classes/Plans/PlanMetadata");
const StorageQuotaEnforcer = require("./Globals/Classes/Storage/StorageQuotaEnforcer");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const AuthenticationQueryEngine = require("./Globals/Classes/Database/AuthenticationQueryEngine");
const Organization = require("./Globals/Model/Organization");
const User = require("./Globals/Model/User");
const DeckLicense = require("./Globals/Model/DeckLicense");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { organizationStatus } = require("./Globals/Enumerations/OrganizationStatus");
const { tagMatchModes } = require("./Globals/Enumerations/TagMatchModes");
const { planFeatures } = require("./Globals/Enumerations/PlanFeatures");
const { planTiers } = require("./Globals/Enumerations/PlanTiers");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-view-";

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
    {
        passedCount = passedCount + 1;
        console.log(`  PASS  ${description}`);
    }
    else
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  ${description}`);
    }
}

function skip(description)
{
    skippedCount = skippedCount + 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}

/**
 * A request stand-in carrying only what the scope resolver reads. Deliberately
 * NOT a mock of the framework — the resolver's contract is "headers plus an
 * optional loaded user", and pinning it to that keeps the harness honest about
 * how little it is allowed to depend on.
 */
function buildRequest(organizationContextId, user)
{
    const headers = {};
    if (typeof organizationContextId === "string" && organizationContextId.length > 0)
    {
        headers[OrganizationScopeResolver.CONTEXT_HEADER_NAME] = organizationContextId;
    }
    return { headers: headers, user: user || null };
}


async function runAlwaysOnTier()
{
    section("Tier 1 — scope keys, licence scope, rule validation and wiring");

    // ── Scope-key composition ─────────────────────────────────────────────
    const personalKey = OrganizationScopeResolver.buildScopeKey("user-1", "");
    const organizationKey = OrganizationScopeResolver.buildScopeKey("user-1", "org-9");

    assert(personalKey === "user-1", "A blank organization id composes to the plain user id");
    assert(organizationKey === "user-1::org:org-9", "An organization scope key is <userId>::org:<organizationId>");
    assert(OrganizationScopeResolver.isOrganizationScopeKey(organizationKey) === true, "An organization scope key is recognised as one");
    assert(OrganizationScopeResolver.isOrganizationScopeKey(personalKey) === false, "A personal scope key is not mistaken for an organization one");
    assert(OrganizationScopeResolver.buildScopeKey("user-1", null) === "user-1", "A null organization id degrades to the personal scope rather than a malformed key");

    // The two sides MUST agree byte-for-byte or every organization library
    // silently orphans: the client writes under one prefix and the server reads
    // another. Read from the client source rather than restated here, so the
    // check fails when either side drifts.
    const clientIdentitySource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Globals", "Classes", "Organization", "OrganizationContextIdentity.js"), "utf8");
    const clientSeparatorMatch = clientIdentitySource.match(/static SEPARATOR = "(.*?)";/);
    assert(clientSeparatorMatch !== null, "The client declares a scope separator");
    assert(clientSeparatorMatch !== null && organizationKey === `user-1${clientSeparatorMatch[1]}org-9`, "The client and server compose the identical scope key");

    // ── Licence visibility ────────────────────────────────────────────────
    const personalCondition = PaidDeckScopeResolver.buildVisibleScopeCondition("user-1", "user-1");
    const organizationCondition = PaidDeckScopeResolver.buildVisibleScopeCondition("user-1::org:org-9", "user-1");

    assert(personalCondition.$in.includes("user-1"), "The personal view sees licences scoped to the account");
    assert(personalCondition.$in.includes(""), "The personal view sees licences whose scope is the empty legacy value");
    assert(personalCondition.$in.includes(null), "The personal view matches licences predating the scope field at all");
    assert(organizationCondition.$in.length === 1 && organizationCondition.$in[0] === "user-1::org:org-9", "An organization view sees ONLY that organization's licences — marketplace purchases stay personal");

    const scopedLicense = new DeckLicense({ userId: "user-1", deckId: "deck-1", scopeKey: "user-1::org:org-9" });
    const legacyLicense = new DeckLicense({ userId: "user-1", deckId: "deck-2" });
    assert(PaidDeckScopeResolver.resolveForLicense(scopedLicense, "user-1") === "user-1::org:org-9", "A scoped licence seeds into its organization's library");
    assert(PaidDeckScopeResolver.resolveForLicense(legacyLicense, "user-1") === "user-1", "A licence with no scope seeds into the buyer's own library");
    assert(PaidDeckScopeResolver.resolveForLicense(null, "user-1") === "user-1", "A missing licence never resolves to an undefined owner key");
    assert(PaidDeckScopeResolver.isOrganizationScopedLicense(scopedLicense) === true, "An organization licence is recognised as one");
    assert(PaidDeckScopeResolver.isOrganizationScopedLicense(legacyLicense) === false, "A marketplace licence is not");

    // ── Permission-rule validation ────────────────────────────────────────
    const validRule = { name: "Final year", tagFilter: ["final-year"], matchMode: tagMatchModes.ANY, allowedFeatures: [planFeatures.MOCK_TEST_EVALUATION], storageGrantBytes: 1024 };
    assert(OrganizationPermissionRuleQueryEngine.validateRule(validRule).valid === true, "A well-formed rule validates");
    assert(OrganizationPermissionRuleQueryEngine.validateRule(null).valid === false, "A null rule is refused");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, name: "" }).valid === false, "A rule with no name is refused — an unnameable rule is an unauditable one");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, matchMode: 99 }).valid === false, "An unknown match mode is refused rather than defaulted");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, allowedFeatures: [9999] }).valid === false, "A feature value outside the enum is refused");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, allowedFeatures: "GENERATION" }).valid === false, "A non-array feature list is refused");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, storageGrantBytes: -1 }).valid === false, "A negative storage grant is refused");
    assert(OrganizationPermissionRuleQueryEngine.validateRule({ ...validRule, storageGrantBytes: 1.5 }).valid === false, "A fractional byte count is refused");
    assert(OrganizationPermissionRuleQueryEngine.MAXIMUM_RULES_PER_ORGANIZATION > 0, "A rule-count ceiling is declared");

    // ── Routes ────────────────────────────────────────────────────────────
    const organizationRoutes = [];
    handleOrganizationEndpoints({ handle: (routeDefinition) => organizationRoutes.push(routeDefinition) });
    const organizationRoutePaths = organizationRoutes.map(route => route.routePath);

    assert(organizationRoutePaths.includes("/Organization/Permissions"), "Reading the permission rules is a route");
    assert(organizationRoutePaths.includes("/Organization/Permissions/Set"), "Writing the permission rules is a route");
    assert(organizationRoutes.every(route => Array.isArray(route.plugins) && route.plugins.length > 0), "Every organization route carries an authorization plugin");

    // ── Gate wiring ───────────────────────────────────────────────────────
    // The request-aware gate is what makes an organization's rules apply at all.
    // A call site left on the personal-only check would silently evaluate an
    // institute's member against their private plan, so the wiring is asserted
    // rather than assumed.
    assert(typeof PlanEntitlementGate.requireFeatureForRequest === "function", "The request-aware entitlement gate exists");

    const gatedCallSites =
    [
        "Endpoints/Analysis/QueueDeckAnalysis.js",
        "Endpoints/AskAi/Helpers/AskAiStreamRunner.js",
        "Endpoints/AutomaticGeneration/Generate.js",
        "Endpoints/AutomaticGeneration/Helpers/AutoFillOptionsRunner.js",
        "Endpoints/MockTest/EvaluateAttempt.js",
        "Endpoints/MockTest/TranscribeOfflineAttempt.js"
    ];

    for (const relativePath of gatedCallSites)
    {
        const absolutePath = path.join(currentDirectory, relativePath);
        if (!fs.existsSync(absolutePath))
        {
            skip(`${relativePath} — not present at the expected path`);
            continue;
        }
        const source = fs.readFileSync(absolutePath, "utf8");
        assert(source.includes("requireFeatureForRequest"), `${relativePath} evaluates against the active view, not only the personal plan`);
    }

    // CHAT sat in every tier's feature list and was enforced nowhere, so an
    // organization switching it off would have found it still worked.
    const askAiRunnerSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/AskAi/Helpers/AskAiStreamRunner.js"), "utf8");
    assert(askAiRunnerSource.includes("planFeatures.CHAT"), "Chatting with a deck is gated on the CHAT feature");

    // ── Sync scoping ──────────────────────────────────────────────────────
    const syncSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Sync/Sync.js"), "utf8");
    assert(syncSource.includes("OrganizationScopeResolver.resolve"), "The sync push/pull resolves the scope it operates in");
    assert(syncSource.includes("TaskManager.getSyncLockState(personalUserId)"), "The sync lock stays keyed by the account — one engine per device, whichever view it shows");
    assert(syncSource.includes("StorageQuotaEnforcer.isWithinQuota(personalUserId)"), "The storage cap is measured against the account, not the view");
    assert(syncSource.includes("getPaidDeckContentKeyBufferForUser(personalUserId"), "Paid content keys are looked up against the licence holder, not the library");

    const bulkSnapshotSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Sync/BulkSnapshot.js"), "utf8");
    assert(bulkSnapshotSource.includes("OrganizationScopeResolver.resolve"), "A full-resync snapshot streams the scope the request is in");

    const reaperSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/PaidDeck/LapsedPaidDeckReaper.js"), "utf8");
    assert(reaperSource.includes("PaidDeckScopeResolver.resolveForLicense"), "The lapsed-licence reaper tombstones in the library the content actually sits in");

    const preserverSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/Security/LicenseFieldPreserver.js"), "utf8");
    assert(preserverSource.includes("setScopeKey"), "A master-key rotation carries the licence's library forward instead of blanking it");
}


async function runDatabaseTier()
{
    section("Tier 2 — live database (opt-in: VERIFY_ORGANIZATION_DB=1)");

    if (process.env.VERIFY_ORGANIZATION_DB !== "1")
    {
        skip("Database tier not requested — set VERIFY_ORGANIZATION_DB=1 with Mongo running");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("Database tier — MongoDB is not reachable");
        return;
    }

    const createdOrganizationIds = [];
    const createdUserIds = [];
    const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);

    try
    {
        const uniqueSuffix = `${Date.now()}`;

        // ── Fixtures ──────────────────────────────────────────────────────
        const memberUserId = `${TEST_NAME_PREFIX}member-${uniqueSuffix}`;
        const memberEmail = `${TEST_NAME_PREFIX}member-${uniqueSuffix}@example.test`;
        const outsiderUserId = `${TEST_NAME_PREFIX}outsider-${uniqueSuffix}`;
        const outsiderEmail = `${TEST_NAME_PREFIX}outsider-${uniqueSuffix}@example.test`;

        for (const [userId, email] of [[memberUserId, memberEmail], [outsiderUserId, outsiderEmail]])
        {
            const user = new User({ id: userId, additionalData: { email: email } });
            await usersCollection.insertOne(user.toJson());
            createdUserIds.push(userId);
        }

        const organization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}@example.test`,
            status: organizationStatus.ACTIVE,
            maxMembers: 50,
            // Sold: mock-test evaluation and curated study only. Generation is
            // deliberately withheld so a rule granting it can be shown to be
            // clamped away rather than honoured.
            grantableFeatures: [planFeatures.MOCK_TEST_EVALUATION, planFeatures.CURATED_STUDY],
            maxStorageGrantBytesPerMember: 100 * 1024 * 1024
        });
        await OrganizationQueryEngine.createOrganization(organization);
        createdOrganizationIds.push(organization.getId());

        await OrganizationMemberQueryEngine.addMember(organization.getId(), memberEmail, "harness");
        await OrganizationMemberQueryEngine.replaceProfilesForExistingMembers
        (
            organization.getId(),
            [{ email: memberEmail, tags: ["final-year"], attributes: {}, attributesNormalised: {} }]
        );
        // The membership is matched by email until the member signs in; binding
        // the account id here is what that sign-in does.
        await OrganizationMemberQueryEngine.backfillUserId(memberEmail, memberUserId);

        const storedMember = await OrganizationMemberQueryEngine.findMemberByUserIdOrEmail(organization.getId(), memberUserId, memberEmail);
        assert(storedMember !== null, "The fixture member is on the roster");
        assert(storedMember !== null && storedMember.getTags().includes("final-year"), "The fixture member carries the tag the rules target");

        const memberUser = await AuthenticationQueryEngine.getUserById(memberUserId);
        const outsiderUser = await AuthenticationQueryEngine.getUserById(outsiderUserId);

        // ── Scope resolution and the forged context ───────────────────────
        section("Scope resolution");

        const memberScope = await OrganizationScopeResolver.resolve(buildRequest(organization.getId(), memberUser), memberUserId);
        assert(memberScope.organizationId === organization.getId(), "A member's context is honoured");
        assert(memberScope.scopeKey === `${memberUserId}::org:${organization.getId()}`, "A member reads and writes in the organization's namespace");

        const forgedScope = await OrganizationScopeResolver.resolve(buildRequest(organization.getId(), outsiderUser), outsiderUserId);
        assert(forgedScope.organizationId === null, "A forged context for a non-member is refused");
        assert(forgedScope.scopeKey === outsiderUserId, "A refused context falls back to the caller's own library rather than erroring");

        const unknownScope = await OrganizationScopeResolver.resolve(buildRequest("no-such-organization", memberUser), memberUserId);
        assert(unknownScope.scopeKey === memberUserId, "A context naming an organization that does not exist falls back to personal");

        const absentScope = await OrganizationScopeResolver.resolve(buildRequest("", memberUser), memberUserId);
        assert(absentScope.organizationId === null && absentScope.scopeKey === memberUserId, "No context at all means the personal view");

        const allScopes = await OrganizationScopeResolver.listAllScopeKeysForUser(memberUser);
        assert(allScopes.scopeKeys.includes(memberUserId), "The account's own library is one of its scopes");
        assert(allScopes.scopeKeys.includes(memberScope.scopeKey), "Each organization the account belongs to is another");

        // ── Permission rules ──────────────────────────────────────────────
        section("Permission rules");

        await OrganizationPermissionRuleQueryEngine.replaceRules
        (
            organization.getId(),
            [
                {
                    name: "Final-year cohort",
                    tagFilter: ["final-year"],
                    matchMode: tagMatchModes.ANY,
                    // AUTOMATIC_GENERATION is NOT in this organization's
                    // allow-list. Asking for it must buy nothing.
                    allowedFeatures: [planFeatures.MOCK_TEST_EVALUATION, planFeatures.AUTOMATIC_GENERATION],
                    storageGrantBytes: 50 * 1024 * 1024
                },
                {
                    name: "Everyone",
                    tagFilter: [],
                    matchMode: tagMatchModes.EVERYONE,
                    allowedFeatures: [planFeatures.CURATED_STUDY],
                    storageGrantBytes: 20 * 1024 * 1024
                },
                {
                    name: "Over ceiling",
                    tagFilter: ["nobody-has-this-tag"],
                    matchMode: tagMatchModes.ANY,
                    allowedFeatures: [planFeatures.CURATED_STUDY],
                    storageGrantBytes: 900 * 1024 * 1024
                }
            ],
            organization.getGrantableFeatures(),
            organization.getMaxStorageGrantBytesPerMember()
        );

        const storedRules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organization.getId());
        assert(storedRules.length === 3, "The whole rule set is replaced in one write");

        const cohortRule = storedRules.find(rule => rule.getName() === "Final-year cohort");
        assert(cohortRule !== undefined && !cohortRule.getAllowedFeatures().includes(planFeatures.AUTOMATIC_GENERATION), "A feature outside the agreement is clamped away ON WRITE, so nothing unenforceable is ever stored");
        assert(cohortRule !== undefined && cohortRule.getAllowedFeatures().includes(planFeatures.MOCK_TEST_EVALUATION), "A feature inside the agreement survives the clamp");

        const overCeilingRule = storedRules.find(rule => rule.getName() === "Over ceiling");
        assert(overCeilingRule !== undefined && overCeilingRule.getStorageGrantBytes() === organization.getMaxStorageGrantBytesPerMember(), "A storage grant above the per-member ceiling is clamped to it");

        // ── Effective entitlements ────────────────────────────────────────
        section("Effective entitlements");

        const entitlement = await OrganizationFeatureResolver.resolveForMember(organization, memberUserId, memberEmail);
        const freeFloor = PlanMetadata.getFeatureSet(planTiers.FREE);

        assert(entitlement.matchedRuleNames.includes("Final-year cohort"), "A tag rule matches the member holding the tag");
        assert(entitlement.matchedRuleNames.includes("Everyone"), "An EVERYONE rule matches regardless of tags");
        assert(!entitlement.matchedRuleNames.includes("Over ceiling"), "A tag rule does not match a member without the tag");

        assert(entitlement.featureValues.includes(planFeatures.MOCK_TEST_EVALUATION), "The member gets what one matching rule granted");
        assert(entitlement.featureValues.includes(planFeatures.CURATED_STUDY), "…and what the other one granted — matching rules UNION, they do not override");
        assert(!entitlement.featureValues.includes(planFeatures.AUTOMATIC_GENERATION), "…and nothing outside the organization's agreement");

        for (const floorFeature of freeFloor)
        {
            assert(entitlement.featureValues.includes(floorFeature), `The Free-tier floor feature ${floorFeature} cannot be withheld by an organization`);
        }

        assert(entitlement.storageGrantBytes === 50 * 1024 * 1024, "Two matching storage grants take the LARGEST, never the sum and never the last");

        const outsiderEntitlement = await OrganizationFeatureResolver.resolveForMember(organization, outsiderUserId, outsiderEmail);
        assert(outsiderEntitlement.storageGrantBytes === 0, "A non-member gets nothing from the organization");
        assert(freeFloor.every(floorFeature => outsiderEntitlement.featureValues.includes(floorFeature)), "…but still keeps the platform floor");

        // ── The gate, in both views ───────────────────────────────────────
        section("Entitlement gate");

        const organizationRequest = buildRequest(organization.getId(), memberUser);
        const personalRequest = buildRequest("", memberUser);

        const grantedInOrganization = await PlanEntitlementGate.requireFeatureForRequest(organizationRequest, memberUserId, planFeatures.MOCK_TEST_EVALUATION);
        assert(grantedInOrganization.allowed === true, "A feature the institute granted is allowed inside its view");
        assert(grantedInOrganization.organizationId === organization.getId(), "…and the gate reports which view answered");
        assert(grantedInOrganization.requiredTier === null, "…with no upgrade tier, because buying a plan would not change it");

        const withheldInOrganization = await PlanEntitlementGate.requireFeatureForRequest(organizationRequest, memberUserId, planFeatures.AUTOMATIC_GENERATION);
        assert(withheldInOrganization.allowed === false, "A feature the institute did not grant is refused inside its view");
        assert(withheldInOrganization.reason === ErrorCodes.FEATURE_NOT_IN_PLAN, "…with FEATURE_NOT_IN_PLAN, not a credit-shaped refusal");

        const floorInOrganization = await PlanEntitlementGate.requireFeatureForRequest(organizationRequest, memberUserId, freeFloor[0]);
        assert(floorInOrganization.allowed === true, "The Free floor still passes inside an organization view");

        const grantedInPersonal = await PlanEntitlementGate.requireFeatureForRequest(personalRequest, memberUserId, planFeatures.MOCK_TEST_EVALUATION);
        const personalPlanHasIt = PlanMetadata.hasFeature(planTiers.FREE, planFeatures.MOCK_TEST_EVALUATION);
        assert(grantedInPersonal.allowed === personalPlanHasIt, "An organization's grant does NOT follow the member into their own library");

        const forgedGate = await PlanEntitlementGate.requireFeatureForRequest(buildRequest(organization.getId(), outsiderUser), outsiderUserId, planFeatures.MOCK_TEST_EVALUATION);
        assert(forgedGate.organizationId === null, "A forged context cannot borrow an organization's entitlements");

        // ── Storage: one meter, both libraries ────────────────────────────
        section("Storage");

        StorageQuotaEnforcer.invalidateCache?.(memberUserId);

        const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
        const personalRowId = `${TEST_NAME_PREFIX}deck-personal-${uniqueSuffix}`;
        const organizationRowId = `${TEST_NAME_PREFIX}deck-organization-${uniqueSuffix}`;

        await decksCollection.insertMany
        ([
            { userId: memberUserId, data: { id: personalRowId, name: "personal" }, serverUpdatedAt: new Date() },
            { userId: memberScope.scopeKey, data: { id: organizationRowId, name: "organization" }, serverUpdatedAt: new Date() }
        ]);

        try
        {
            const usedWithBoth = await StorageQuotaEnforcer.getUsedBytes(memberUserId, true);

            await decksCollection.deleteOne({ userId: memberScope.scopeKey, "data.id": organizationRowId });
            const usedWithPersonalOnly = await StorageQuotaEnforcer.getUsedBytes(memberUserId, true);

            assert(usedWithBoth > usedWithPersonalOnly, "The storage meter counts what the member holds in an organization's library as well as their own");

            const limitBytes = await StorageQuotaEnforcer.getLimitBytes(memberUserId);
            const planStorageBytes = PlanMetadata.getStorageBytes(planTiers.FREE);
            assert(limitBytes >= planStorageBytes + entitlement.storageGrantBytes, "The cap is the personal plan PLUS what the organization granted");
        }
        finally
        {
            await decksCollection.deleteMany({ userId: { $in: [memberUserId, memberScope.scopeKey] }, "data.id": { $in: [personalRowId, organizationRowId] } });
            StorageQuotaEnforcer.invalidateCache?.(memberUserId);
        }

        // ── Rules die with the organization ───────────────────────────────
        section("Teardown cascade");

        await OrganizationQueryEngine.deleteOrganization(organization.getId());
        createdOrganizationIds.splice(createdOrganizationIds.indexOf(organization.getId()), 1);

        const orphanRules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(organization.getId());
        assert(orphanRules.length === 0, "Deleting an organization takes its permission rules with it — an orphan rule would silently grant nothing to nobody forever");
    }
    catch (databaseError)
    {
        failedCount = failedCount + 1;
        console.log(`  FAIL  Database tier threw: ${databaseError.message}`);
        console.log(databaseError.stack);
    }
    finally
    {
        try
        {
            if (createdUserIds.length > 0)
            {
                await usersCollection.deleteMany({ id: { $in: createdUserIds } });
            }

            for (const organizationId of createdOrganizationIds)
            {
                await OrganizationQueryEngine.deleteOrganization(organizationId);
            }
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`);
        }
    }
}


async function main()
{
    console.log("CogniumLearn — organization view verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();

    console.log(`\n---------------------------------------------`);
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("\nFATAL — verification harness crashed:");
    console.error(fatalError);
    process.exit(1);
});
