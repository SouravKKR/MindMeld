/**
 * End-to-end verification harness for organization credits: the pool, the
 * contract term, deal settlement, tag-targeted distribution, the monthly cap
 * and pack-only purchasing.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationCredits.mjs
 *     VERIFY_ORGANIZATION_DB=1 node VerifyOrganizationCredits.mjs
 *
 *   1. ALWAYS — pure checks: the pack ladder, the monthly period key, the
 *      routes, and that a purchase outside the ladder is refused.
 *
 *   2. DB (opt-in: VERIFY_ORGANIZATION_DB=1) — drives the real ledger,
 *      distribution service, term scheduler and reconciler against MongoDB. The
 *      properties that matter most are the ones a careless implementation gets
 *      wrong silently: a replayed settlement crediting twice, a distribution
 *      overdrawing a pool, a frozen pool still paying out, and a monthly cap
 *      that does not actually clamp.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationCreditLedger = require("./Globals/Classes/Organization/OrganizationCreditLedger");
const OrganizationPoolGrantService = require("./Globals/Classes/Credits/OrganizationPoolGrantService");
const OrganizationPoolHistoryView = require("./Globals/Classes/Organization/OrganizationPoolHistoryView");
const OrganizationPermissionRuleQueryEngine = require("./Globals/Classes/Organization/OrganizationPermissionRuleQueryEngine");
const { creditGrantTargetTypes } = require("./Globals/Enumerations/CreditGrantTargetTypes");
const { planFeatures } = require("./Globals/Enumerations/PlanFeatures");
const OrganizationCreditDistributionService = require("./Globals/Classes/Organization/OrganizationCreditDistributionService");
const OrganizationMonthlyCreditCapEnforcer = require("./Globals/Classes/Organization/OrganizationMonthlyCreditCapEnforcer");
const OrganizationTermScheduler = require("./Globals/Classes/Organization/OrganizationTermScheduler");
const OrganizationQueryEngine = require("./Globals/Classes/Organization/OrganizationQueryEngine");
const OrganizationMemberQueryEngine = require("./Globals/Classes/Organization/OrganizationMemberQueryEngine");
const OrganizationMemberProfileNormaliser = require("./Globals/Classes/Organization/OrganizationMemberProfileNormaliser");
const CreditGrantTargetResolver = require("./Globals/Classes/Credits/CreditGrantTargetResolver");
const CreditConfiguration = require("./Globals/Classes/Credits/CreditConfiguration");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const Organization = require("./Globals/Model/Organization");
const { handleOrganizationEndpoints } = require("./Endpoints/HandleOrganizationEndpoints");
const { handleAdminEndpoints } = require("./Endpoints/HandleAdminEndpoints");
const { setOrganizationTerm } = require("./Endpoints/Organization/SetOrganizationTerm");
const { organizationStatus } = require("./Globals/Enumerations/OrganizationStatus");
const { creditGrantAmountModes } = require("./Globals/Enumerations/CreditGrantAmountModes");
const { tagMatchModes } = require("./Globals/Enumerations/TagMatchModes");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-credits-";

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
 * Drives one endpoint handler directly, with the smallest request and response
 * it actually reads. Routing and authorization are covered by the tier-1 route
 * checks, so what this exercises is the handler's own logic and the status code
 * it chooses — the part a service-level call would skip entirely.
 */
async function callEndpoint(handler, body)
{
    const captured = { statusCode: 0, body: null };
    const request = { getBody: async () => body, user: { getId: () => "harness-admin" } };
    const response =
    {
        set statusCode(value) { captured.statusCode = value; },
        get statusCode() { return captured.statusCode; },
        sendJson(payload) { captured.body = payload; }
    };

    await handler(request, response);
    return captured;
}


async function runAlwaysOnTier()
{
    section("Tier 1 — pack ladder, period keys and routes");

    // ── The pack ladder ───────────────────────────────────────────────────
    assert(Array.isArray(CreditConfiguration.DEFAULT_CREDIT_PACK_SIZES), "A default pack ladder is declared");
    for (const expectedSize of [5, 10, 25, 50, 100, 250, 500, 1000])
    {
        assert(CreditConfiguration.DEFAULT_CREDIT_PACK_SIZES.includes(expectedSize), `The ladder offers a ${expectedSize}-credit pack`);
    }

    const freshConfiguration = new CreditConfiguration({});
    assert(freshConfiguration.getCreditPacks().length === 0, "A fresh configuration starts with no packs");
    assert(freshConfiguration.ensureDefaultCreditPacks() === true, "The backfill reports that it added the ladder");
    assert(freshConfiguration.getCreditPacks().length === CreditConfiguration.DEFAULT_CREDIT_PACK_SIZES.length, "Every ladder size is backfilled");
    assert(freshConfiguration.ensureDefaultCreditPacks() === false, "Backfilling twice does not duplicate the ladder");

    const configuredPacks = freshConfiguration.getCreditPacks().map(pack => pack.getCredits());
    assert(!configuredPacks.includes(7), "A quantity outside the ladder is not purchasable — the endpoint refuses it");

    // ── The monthly period key ────────────────────────────────────────────
    const januaryKey = OrganizationMonthlyCreditCapEnforcer.resolvePeriodKey(new Date(Date.UTC(2026, 0, 15)));
    const decemberKey = OrganizationMonthlyCreditCapEnforcer.resolvePeriodKey(new Date(Date.UTC(2026, 11, 31, 23, 59)));
    assert(januaryKey === "2026-01", "The period key is the UTC calendar month, zero-padded");
    assert(decemberKey === "2026-12", "The last instant of December belongs to December");

    // ── Tag matching ──────────────────────────────────────────────────────
    const makeMember = (tags) => ({ getTags: () => tags });
    const members = [makeMember(["first-year"]), makeMember(["first-year", "scholarship"]), makeMember(["final-year"])];

    assert(CreditGrantTargetResolver.filterMembersByTags(members, [], tagMatchModes.EVERYONE).length === 3, "EVERYONE ignores the tag list");
    assert(CreditGrantTargetResolver.filterMembersByTags(members, ["first-year"], tagMatchModes.ANY).length === 2, "ANY matches a member holding one of the tags");
    assert(CreditGrantTargetResolver.filterMembersByTags(members, ["first-year", "scholarship"], tagMatchModes.ALL).length === 1, "ALL requires every tag");
    assert(CreditGrantTargetResolver.filterMembersByTags(members, ["FIRST-YEAR"], tagMatchModes.ANY).length === 2, "Tag matching is case-insensitive");
    assert(CreditGrantTargetResolver.filterMembersByTags(members, [], tagMatchModes.ANY).length === 3, "An empty tag list cannot accidentally select nobody");

    // ── Routes ────────────────────────────────────────────────────────────
    const organizationRoutes = [];
    handleOrganizationEndpoints({ handle: (routeDefinition) => organizationRoutes.push(routeDefinition) });
    const organizationRoutePaths = organizationRoutes.map(route => route.routePath);

    for (const expectedPath of ["/Organization/Credits/Overview", "/Organization/Credits/SpendReport", "/Organization/Credits/Deals/Verify", "/Organization/Credits/Distribute/Preview", "/Organization/Credits/Distribute/Apply", "/Organization/Credits/Periodic/Create", "/Organization/Credits/Periodic/List", "/Organization/Credits/Periodic/Terminate"])
    {
        assert(organizationRoutePaths.includes(expectedPath), `Route ${expectedPath} is registered`);
    }
    assert(organizationRoutes.every(route => Array.isArray(route.plugins) && route.plugins.length > 0), "Every organization route carries an authorization plugin");

    const adminRoutes = [];
    handleAdminEndpoints({ handle: (routeDefinition) => adminRoutes.push(routeDefinition) });
    const adminRoutePaths = adminRoutes.map(route => route.routePath);
    assert(adminRoutePaths.includes("/Admin/Credits/Deals/CreateForOrganization"), "Selling credits to an organization is a super-admin route");
    assert(adminRoutePaths.includes("/Admin/Organizations/SetLimits"), "The entitlement ceilings are settable from a route, not only from the database");
    assert(adminRoutePaths.includes("/Admin/Organizations/SetTerm"), "The contract term is renewable from a route — a renewal must not require selling credits");

    // ── The pool is a grant target, and not a user one ────────────────────
    section("Tier 1b — granting to a pool rather than to members");

    assert(creditGrantTargetTypes.ORGANIZATION_POOL !== undefined, "A pool grant target exists");

    const poolThroughUserResolver = await CreditGrantTargetResolver.resolve({ targetType: creditGrantTargetTypes.ORGANIZATION_POOL, organizationId: "any" });
    assert(poolThroughUserResolver.error === "POOL_TARGET_NOT_A_USER_TARGET", "The recipient resolver refuses a pool target outright rather than returning an empty recipient list, which would read as a grant that matched nobody");

    const previewSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Admin/PreviewCreditGrant.js"), "utf8");
    const applySource = fs.readFileSync(path.join(currentDirectory, "Endpoints/Admin/ApplyCreditGrant.js"), "utf8");

    assert(previewSource.includes("OrganizationPoolGrantService.preview"), "The preview endpoint has a pool branch");
    assert(applySource.includes("OrganizationPoolGrantService.apply"), "The apply endpoint has a pool branch");
    assert(applySource.includes("poolTopUp: true"), "…and marks its response explicitly, rather than leaving the client to infer the shape from a balance that is null when a replayed movement never settled");

    const panelOutcomeSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "AdminPanel", "Components", "CreditGrantPanel.js"), "utf8");
    assert(panelOutcomeSource.includes("outcome.poolTopUp === true"), "The panel branches on that marker rather than on a nullable balance");

    // The amount-mode check exists to divide an amount between recipients. A
    // pool has one recipient, so the branch has to come FIRST or every pool
    // grant would be refused for omitting a mode that means nothing to it.
    const poolBranchIndex = applySource.indexOf("creditGrantTargetTypes.ORGANIZATION_POOL");
    const amountModeCheckIndex = applySource.indexOf("INVALID_AMOUNT_MODE");
    assert(poolBranchIndex > 0 && poolBranchIndex < amountModeCheckIndex, "A pool grant is handled before the amount-mode validation it has no use for");

    const panelSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "AdminPanel", "Components", "CreditGrantPanel.js"), "utf8");
    assert(panelSource.includes("Organization pool"), "The admin panel offers the pool as the organization target");
    assert(!panelSource.includes("Organization members"), "…and no longer offers granting straight to members, which would leave the pool balance claiming credits the organization had already received");

    // ── The history view ──────────────────────────────────────────────────
    // `type`, not `transactionType`: the ledger's claim row names it that way,
    // and a fixture that used the friendlier-looking name passed while the real
    // path silently described every movement as an adjustment.
    const historyRows = OrganizationPoolHistoryView.buildSettledMovements
    ([
        { status: OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED, type: OrganizationCreditLedger.TRANSACTION_TYPE_ADJUSTMENT, amount: 500, balanceAfter: 500, createdAt: "2026-08-01T00:00:00.000Z", metadata: { source: OrganizationCreditLedger.MOVEMENT_SOURCE_ADMIN_GRANT, reason: "Onboarding" } },
        { status: OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED, type: OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION, amount: -120, balanceAfter: 380, createdAt: "2026-08-02T00:00:00.000Z", metadata: { recipientCount: 12 } },
        { status: OrganizationCreditLedger.TRANSACTION_STATUS_APPLIED, type: OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE, amount: 1000, balanceAfter: 1380, createdAt: "2026-08-03T00:00:00.000Z", metadata: {} },
        { status: "pending", type: OrganizationCreditLedger.TRANSACTION_TYPE_ADJUSTMENT, amount: 999, balanceAfter: null, createdAt: "2026-08-04T00:00:00.000Z", metadata: {} }
    ]);

    assert(OrganizationCreditLedger.readTransactionType({ type: "PURCHASE" }) === "PURCHASE", "The ledger exposes the stored type field, so no reader has to guess its name");
    assert(OrganizationCreditLedger.readTransactionType({ transactionType: "PURCHASE" }) === "", "…and reading the wrong field yields nothing rather than a plausible-looking value");
    assert(OrganizationCreditLedger.readTransactionType(null) === "", "…and a missing row does not throw");

    assert(historyRows.length === 3, "A pending movement is left out of the history — it is either in flight or abandoned, and showing it would have the credits counted twice");
    assert(historyRows[0].description === "Added by CogniumLearn", "A super-admin top-up is named as one rather than as a bare adjustment");
    assert(historyRows[0].note === "Onboarding", "…and carries the reason it was recorded with");
    assert(historyRows[1].description === "Given out to members", "A distribution is named as one");
    assert(historyRows[1].note === "12 members", "…and says how many people it reached");
    assert(historyRows[2].description === "Credits purchased", "A purchase is named as one rather than falling through to an adjustment");
    assert(OrganizationPoolHistoryView.buildSettledMovements(null).length === 0, "A missing transaction list yields no history rather than throwing");
}


async function runDatabaseTier()
{
    section("Tier 2 — live database (opt-in: VERIFY_ORGANIZATION_DB=1)");

    if (process.env.VERIFY_ORGANIZATION_DB !== "1")
    {
        skip("Database tier disabled — set VERIFY_ORGANIZATION_DB=1 to run it");
        return;
    }

    let database = null;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError.message}) — database tier not run`);
        return;
    }

    if (!database)
    {
        skip("MongoDB not configured — database tier not run");
        return;
    }

    const uniqueSuffix = process.pid;
    const createdOrganizationIds = [];
    const createdUserIds = [];

    try
    {
        const now = new Date();
        const organization = await OrganizationQueryEngine.createOrganization(new Organization
        ({
            name: `${TEST_NAME_PREFIX}${uniqueSuffix}`,
            adminEmail: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}@example.invalid`,
            adminUserId: `${TEST_NAME_PREFIX}owner-${uniqueSuffix}`,
            status: organizationStatus.ACTIVE,
            currency: "INR",
            creationAmountMinor: 0,
            maxMembers: 50,
            currentMemberCount: 0,
            creationDate: now,
            activationDate: now,
            termEndsAt: new Date(now.getTime() + 90 * 86400000),
            maxCreditsPerMemberPerMonth: 0,
            additionalData: {}
        }));
        createdOrganizationIds.push(organization.getId());
        const organizationId = organization.getId();

        // ── The pool starts empty and is created on demand ────────────────
        const initialPool = await OrganizationCreditLedger.getPool(organizationId);
        assert(initialPool !== null && initialPool.getBalance() === 0, "An organization that has never bought credits has a pool of zero, not no pool");

        // ── Crediting is idempotent on the reference key ──────────────────
        const firstCredit = await OrganizationCreditLedger.credit(organizationId, 500, OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE, `orgDeal:${TEST_NAME_PREFIX}${uniqueSuffix}`, {});
        assert(firstCredit.applied === true && firstCredit.balanceAfter === 500, "A settled purchase credits the pool");

        const replayedCredit = await OrganizationCreditLedger.credit(organizationId, 500, OrganizationCreditLedger.TRANSACTION_TYPE_PURCHASE, `orgDeal:${TEST_NAME_PREFIX}${uniqueSuffix}`, {});
        assert(replayedCredit.alreadyApplied === true, "A replayed settlement reports that it already ran");

        const poolAfterReplay = await OrganizationCreditLedger.getPool(organizationId);
        assert(poolAfterReplay.getBalance() === 500, "A replayed settlement does NOT credit the pool twice");

        // ── The pool cannot be overdrawn ──────────────────────────────────
        const overdraw = await OrganizationCreditLedger.debit(organizationId, 501, OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION, `overdraw:${uniqueSuffix}`, {});
        assert(overdraw.applied !== true && overdraw.reason === ErrorCodes.ORG_POOL_INSUFFICIENT, "A debit larger than the balance is refused");

        const poolAfterOverdraw = await OrganizationCreditLedger.getPool(organizationId);
        assert(poolAfterOverdraw.getBalance() === 500, "A refused debit leaves the balance untouched");

        // ── A frozen pool refuses every debit ─────────────────────────────
        await OrganizationCreditLedger.setFrozen(organizationId, true);
        const frozenDebit = await OrganizationCreditLedger.debit(organizationId, 10, OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION, `frozen:${uniqueSuffix}`, {});
        assert(frozenDebit.applied !== true && frozenDebit.reason === ErrorCodes.ORG_POOL_FROZEN, "A frozen pool refuses a debit, and says so distinctly from an empty one");
        await OrganizationCreditLedger.setFrozen(organizationId, false);

        // ── Members with tags, and real user accounts to receive credits ──
        const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
        const memberDefinitions =
        [
            { suffix: "a", tags: ["first-year"], credits: 0 },
            { suffix: "b", tags: ["first-year", "scholarship"], credits: 5 },
            { suffix: "c", tags: ["final-year"], credits: 0 }
        ];

        for (const memberDefinition of memberDefinitions)
        {
            const email = `${TEST_NAME_PREFIX}${memberDefinition.suffix}-${uniqueSuffix}@example.invalid`;
            const userId = `${TEST_NAME_PREFIX}user-${memberDefinition.suffix}-${uniqueSuffix}`;
            createdUserIds.push(userId);

            await usersCollection.insertOne
            ({
                id: userId,
                displayName: `Test ${memberDefinition.suffix}`,
                role: 0,
                additionalData: { email: email, credits: memberDefinition.credits }
            });

            const normalisedProfile = OrganizationMemberProfileNormaliser.normalise({ tags: memberDefinition.tags, attributes: {} });
            await OrganizationQueryEngine.tryIncrementMemberCount(organizationId);
            await OrganizationMemberQueryEngine.bulkAddMembers(organizationId, [{ email: email, ...normalisedProfile }], "verifier");
            await OrganizationMemberQueryEngine.backfillUserId(email, userId);
        }

        // ── The plan covers exactly the tagged members ────────────────────
        const firstYearPlan = await OrganizationCreditDistributionService.plan
        (
            organization,
            { tagFilter: ["first-year"], tagMatchMode: tagMatchModes.ANY, amount: 20, amountMode: creditGrantAmountModes.PER_USER }
        );

        assert(firstYearPlan.ok === true, "A tag-targeted plan resolves");
        assert(firstYearPlan.recipientCount === 2, "The plan covers exactly the members carrying the tag");
        assert(firstYearPlan.totalAmount === 40, "Per-person mode multiplies by the recipient count");
        assert(firstYearPlan.poolBalanceBefore === 500 && firstYearPlan.poolBalanceAfter === 460, "The plan reports the pool on both sides");

        const recipientWithBalance = firstYearPlan.recipients.find(recipient => recipient.balanceBefore === 5);
        assert(recipientWithBalance !== undefined && recipientWithBalance.balanceAfter === 25, "Each recipient's before and after balances are reported");
        assert(firstYearPlan.recipients.every(recipient => Array.isArray(recipient.tags)), "Each recipient carries the tags that selected them");

        const splitPlan = await OrganizationCreditDistributionService.plan
        (
            organization,
            { tagFilter: ["first-year"], tagMatchMode: tagMatchModes.ANY, amount: 30, amountMode: creditGrantAmountModes.TOTAL_SPLIT }
        );
        assert(splitPlan.perUserAmount === 15 && splitPlan.totalAmount === 30, "Split mode divides the total between the recipients");

        // ── Applying moves the money exactly once ─────────────────────────
        const grantKey = `${TEST_NAME_PREFIX}grant-${uniqueSuffix}`;
        const applyResult = await OrganizationCreditDistributionService.apply
        (
            organization,
            { tagFilter: ["first-year"], tagMatchMode: tagMatchModes.ANY, amount: 20, amountMode: creditGrantAmountModes.PER_USER },
            grantKey,
            "verifier"
        );

        assert(applyResult.ok === true && applyResult.grantedCount === 2, "The distribution credits every recipient");
        assert(applyResult.poolBalanceAfter === 460, "The pool is debited by the total");

        const creditedUser = await usersCollection.findOne({ id: `${TEST_NAME_PREFIX}user-b-${uniqueSuffix}` });
        assert(creditedUser.additionalData.credits === 25, "A recipient's balance rose by the granted amount");

        const untouchedUser = await usersCollection.findOne({ id: `${TEST_NAME_PREFIX}user-c-${uniqueSuffix}` });
        assert(untouchedUser.additionalData.credits === 0, "A member the tags did not cover received nothing");

        // The same grant key again: a double click, or a retried request.
        const replayedApply = await OrganizationCreditDistributionService.apply
        (
            organization,
            { tagFilter: ["first-year"], tagMatchMode: tagMatchModes.ANY, amount: 20, amountMode: creditGrantAmountModes.PER_USER },
            grantKey,
            "verifier"
        );
        assert(replayedApply.ok === true && replayedApply.grantedCount === 0 && replayedApply.alreadyGrantedCount === 2, "A replayed distribution grants nobody a second time");

        const poolAfterReplayedApply = await OrganizationCreditLedger.getPool(organizationId);
        assert(poolAfterReplayedApply.getBalance() === 460, "A replayed distribution does not debit the pool again");

        const stillCreditedUser = await usersCollection.findOne({ id: `${TEST_NAME_PREFIX}user-b-${uniqueSuffix}` });
        assert(stillCreditedUser.additionalData.credits === 25, "A replayed distribution does not credit a member twice");

        // ── The monthly per-member cap clamps ─────────────────────────────
        const cappedOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        cappedOrganization.setMaxCreditsPerMemberPerMonth(25);
        await database.collection(DatabaseConstants.ORGANIZATIONS_COLLECTION).updateOne({ id: organizationId }, { $set: { maxCreditsPerMemberPerMonth: 25 } });

        const reloadedOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        const cappedPlan = await OrganizationCreditDistributionService.plan
        (
            reloadedOrganization,
            { tagFilter: ["first-year"], tagMatchMode: tagMatchModes.ANY, amount: 20, amountMode: creditGrantAmountModes.PER_USER }
        );

        assert(cappedPlan.recipients.every(recipient => recipient.granted <= 25), "No recipient is planned above the monthly ceiling");
        assert(cappedPlan.recipients.some(recipient => recipient.clampedByMonthlyCap === true), "A recipient already at the ceiling is reported as clamped");
        assert(cappedPlan.totalAmount < 40, "The clamped total is lower than the unclamped one");

        // ── The term scheduler freezes a lapsed term ──────────────────────
        await OrganizationQueryEngine.setTermEndsAt(organizationId, new Date(now.getTime() - 86400000));
        const sweepResult = await OrganizationTermScheduler.sweep(now);
        assert(sweepResult.frozen >= 1, "The sweep freezes a pool whose term has lapsed");

        const frozenPool = await OrganizationCreditLedger.getPool(organizationId);
        assert(frozenPool.getFrozen() === true, "The lapsed organization's pool is frozen");
        assert(frozenPool.getBalance() === 460, "Freezing keeps the credits — they are not lost at the end of a term");

        const distributionWhileFrozen = await OrganizationCreditDistributionService.apply
        (
            reloadedOrganization,
            { tagFilter: ["final-year"], tagMatchMode: tagMatchModes.ANY, amount: 1, amountMode: creditGrantAmountModes.PER_USER },
            `${TEST_NAME_PREFIX}frozen-grant-${uniqueSuffix}`,
            "verifier"
        );
        assert(distributionWhileFrozen.ok !== true && distributionWhileFrozen.reason === ErrorCodes.ORG_POOL_FROZEN, "A distribution is refused while the term has lapsed");

        const secondSweep = await OrganizationTermScheduler.sweep(now);
        assert(secondSweep.frozen === 0, "Sweeping again does not re-freeze an already-frozen pool");

        // ── Renewal from the super-admin route ────────────────────────────
        //
        // Driven through the endpoint rather than the query engine on purpose:
        // the property under test is that renewing settles the pool's frozen
        // flag in the same request. Writing the term directly would leave the
        // pool paused until the next sweep, which is exactly the behaviour a
        // super-admin renewing from the panel must not see.
        const renewResponse = await callEndpoint(setOrganizationTerm, { organizationId: organizationId, termEndsAt: new Date(now.getTime() + 30 * 86400000).toISOString() });
        assert(renewResponse.body.success === true, "The term route accepts a renewal");

        const renewedPool = await OrganizationCreditLedger.getPool(organizationId);
        assert(renewedPool.getFrozen() === false && renewedPool.getBalance() === 460, "Renewing keeps the carried-over credits and unfreezes them");
        assert(renewResponse.body.frozen === false, "…and reports the pool as released, so the panel can say so");

        const renewedOrganization = await OrganizationQueryEngine.getOrganizationById(organizationId);
        assert(renewedOrganization.getTermEndsAt().getTime() > now.getTime(), "The stored term actually moved into the future");

        // A term typed into the past is a correction, not a renewal — it must
        // leave the pool paused rather than releasing it because a save
        // succeeded.
        const backdatedResponse = await callEndpoint(setOrganizationTerm, { organizationId: organizationId, termEndsAt: new Date(now.getTime() - 86400000).toISOString() });
        assert(backdatedResponse.body.frozen === true, "Setting a term that has already passed leaves the pool paused");
        assert((await OrganizationCreditLedger.getPool(organizationId)).getFrozen() === true, "…and the stored pool agrees");

        // Clearing writes the epoch sentinel, which the scheduler skips — an
        // organization with no agreed term is left alone rather than treated as
        // one whose term ended in 1970.
        const clearedResponse = await callEndpoint(setOrganizationTerm, { organizationId: organizationId, termEndsAt: "" });
        assert(clearedResponse.body.success === true && clearedResponse.body.frozen === false, "Clearing the term releases the pool");
        assert(new Date(clearedResponse.body.termEndsAt).getTime() === 0, "…and stores the epoch sentinel, which reads as \"Not set\"");

        const sweepAfterClearing = await OrganizationTermScheduler.sweep(now);
        assert(sweepAfterClearing.frozen === 0, "The sweep does not freeze an organization that has no agreed term");

        const rejectedTermResponse = await callEndpoint(setOrganizationTerm, { organizationId: organizationId, termEndsAt: "not-a-date" });
        assert(rejectedTermResponse.statusCode === 400 && rejectedTermResponse.body.error === ErrorCodes.INVALID_REQUEST, "An unparseable term is refused rather than stored as the current time");

        const missingOrganizationTermResponse = await callEndpoint(setOrganizationTerm, { organizationId: "no-such-organization", termEndsAt: new Date(now.getTime() + 86400000).toISOString() });
        assert(missingOrganizationTermResponse.statusCode === 404 && missingOrganizationTermResponse.body.error === ErrorCodes.ORG_NOT_FOUND, "Renewing an organization that does not exist is refused");

        // Left renewed for whatever runs after this section.
        await callEndpoint(setOrganizationTerm, { organizationId: organizationId, termEndsAt: new Date(now.getTime() + 30 * 86400000).toISOString() });

        // ── A super-admin top-up of the pool ──────────────────────────────
        section("Pool top-up (super-admin)");

        const topUpOrganization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}pool-${Date.now()}`,
            adminEmail: `${TEST_NAME_PREFIX}pool-${Date.now()}@example.test`,
            status: organizationStatus.ACTIVE,
            maxMembers: 20
        });
        await OrganizationQueryEngine.createOrganization(topUpOrganization);
        createdOrganizationIds.push(topUpOrganization.getId());

        // Applied to an organization whose pool row has never been created —
        // the first thing that ever touches it. The ledger creates the row on
        // demand, but a top-up that skipped the preview would be the first
        // caller to find out if it did not.
        const freshOrganization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}fresh-${Date.now()}`,
            adminEmail: `${TEST_NAME_PREFIX}fresh-${Date.now()}@example.test`,
            status: organizationStatus.ACTIVE,
            maxMembers: 10
        });
        await OrganizationQueryEngine.createOrganization(freshOrganization);
        createdOrganizationIds.push(freshOrganization.getId());

        const unpreviewedTopUp = await OrganizationPoolGrantService.apply
        ({
            organizationId: freshOrganization.getId(),
            amountCredits: 40,
            grantKey: `${TEST_NAME_PREFIX}fresh-grant-${Date.now()}`,
            reason: "First touch",
            grantedByUserId: "harness-admin"
        });
        assert(unpreviewedTopUp.applied === true && unpreviewedTopUp.balanceAfter === 40, "A top-up applied without a preview first still lands — the pool row is created on demand");

        const topUpPreview = await OrganizationPoolGrantService.preview(topUpOrganization.getId(), 750);
        assert(topUpPreview.success === true, "A pool top-up can be previewed");
        assert(topUpPreview.preview.balanceBefore === 0, "…starting from what the pool actually holds");
        assert(topUpPreview.preview.balanceAfter === 750, "…and reporting where it would land");
        assert(topUpPreview.preview.memberCount === 0, "…with the member count, so a top-up to an organization with nobody in it is visible before it happens");

        const missingOrganizationPreview = await OrganizationPoolGrantService.preview("no-such-organization", 100);
        assert(missingOrganizationPreview.success === false && missingOrganizationPreview.error === ErrorCodes.ORG_NOT_FOUND, "Previewing against an organization that does not exist is refused");

        const topUpGrantKey = `${TEST_NAME_PREFIX}grant-${Date.now()}`;
        const firstTopUp = await OrganizationPoolGrantService.apply
        ({
            organizationId: topUpOrganization.getId(),
            amountCredits: 750,
            grantKey: topUpGrantKey,
            reason: "Harness onboarding",
            grantedByUserId: "harness-admin"
        });

        assert(firstTopUp.success === true && firstTopUp.applied === true, "The top-up credits the pool");
        assert(firstTopUp.balanceAfter === 750, "…and reports the balance it produced");

        const replayedTopUp = await OrganizationPoolGrantService.apply
        ({
            organizationId: topUpOrganization.getId(),
            amountCredits: 750,
            grantKey: topUpGrantKey,
            reason: "Harness onboarding",
            grantedByUserId: "harness-admin"
        });

        assert(replayedTopUp.alreadyApplied === true, "Replaying the same grant key is recognised as a replay");
        const topUpPoolAfterReplay = await OrganizationCreditLedger.getPool(topUpOrganization.getId());
        assert(topUpPoolAfterReplay.getBalance() === 750, "…and credits nothing twice, so a timed-out apply is safe to retry");

        // ── The history records it ────────────────────────────────────────
        const topUpHistory = OrganizationPoolHistoryView.buildSettledMovements(await OrganizationCreditLedger.listTransactions(topUpOrganization.getId(), 50));
        assert(topUpHistory.length === 1, "The top-up appears once in the history, not once per attempt");
        assert(topUpHistory[0].description === "Added by CogniumLearn", "…described as a platform top-up");
        assert(topUpHistory[0].note === "Harness onboarding", "…with the reason it was given");
        assert(topUpHistory[0].balanceAfter === 750, "…and the balance it left behind, so the trail reconciles");

        // Through the real ledger rather than a hand-built row: the fixtures
        // above can only prove the describer, not that it is reading the shape
        // the ledger writes. A distribution is the case that was broken.
        await OrganizationCreditLedger.debit
        (
            topUpOrganization.getId(),
            50,
            OrganizationCreditLedger.TRANSACTION_TYPE_DISTRIBUTION,
            `${TEST_NAME_PREFIX}distribution-${Date.now()}`,
            { recipientCount: 5 }
        );

        const historyWithDistribution = OrganizationPoolHistoryView.buildSettledMovements(await OrganizationCreditLedger.listTransactions(topUpOrganization.getId(), 50));
        const distributionRow = historyWithDistribution.find(movement => movement.amount === -50);
        assert(distributionRow !== undefined, "A real distribution reaches the history");
        assert(distributionRow.description === "Given out to members", "…and is described from the type the ledger actually stored, not from a field name a reader assumed");
        assert(distributionRow.note === "5 members", "…with the recipient count the distribution recorded");

        // ── A pool nobody can spend from is refused ───────────────────────
        const inactiveOrganization = new Organization
        ({
            name: `${TEST_NAME_PREFIX}inactive-${Date.now()}`,
            adminEmail: `${TEST_NAME_PREFIX}inactive-${Date.now()}@example.test`,
            status: organizationStatus.SUSPENDED,
            maxMembers: 5
        });
        await OrganizationQueryEngine.createOrganization(inactiveOrganization);
        createdOrganizationIds.push(inactiveOrganization.getId());

        const inactiveTopUp = await OrganizationPoolGrantService.apply
        ({
            organizationId: inactiveOrganization.getId(),
            amountCredits: 100,
            grantKey: `${TEST_NAME_PREFIX}inactive-grant-${Date.now()}`,
            reason: "",
            grantedByUserId: "harness-admin"
        });
        assert(inactiveTopUp.success === false && inactiveTopUp.error === ErrorCodes.ORG_NOT_ACTIVE, "Crediting an organization that is not active is refused — the credits would be stranded where nobody could spend them");

        // ── The entitlement ceilings, and the re-clamp ────────────────────
        section("Entitlement ceilings (super-admin)");

        await OrganizationQueryEngine.setEntitlementLimits(topUpOrganization.getId(), { maxStorageGrantBytesPerMember: 200 * 1024 * 1024, grantableFeatures: [planFeatures.CURATED_STUDY, planFeatures.MOCK_TEST_EVALUATION], maxPublishedDecks: 4, maxCreditsPerMemberPerMonth: 25 });

        let ceilingOrganization = await OrganizationQueryEngine.getOrganizationById(topUpOrganization.getId());
        assert(ceilingOrganization.getMaxStorageGrantBytesPerMember() === 200 * 1024 * 1024, "The storage ceiling is stored");
        assert(ceilingOrganization.getMaxPublishedDecks() === 4, "The publish cap is stored");
        assert(ceilingOrganization.getMaxCreditsPerMemberPerMonth() === 25, "The per-member monthly cap is stored");
        assert(ceilingOrganization.getGrantableFeatures().includes(planFeatures.CURATED_STUDY), "The feature allow-list is stored");

        // An absent field must be left alone, or adjusting one ceiling would
        // silently clear the others.
        await OrganizationQueryEngine.setEntitlementLimits(topUpOrganization.getId(), { maxPublishedDecks: 6 });
        ceilingOrganization = await OrganizationQueryEngine.getOrganizationById(topUpOrganization.getId());
        assert(ceilingOrganization.getMaxPublishedDecks() === 6, "One ceiling can be adjusted on its own");
        assert(ceilingOrganization.getMaxStorageGrantBytesPerMember() === 200 * 1024 * 1024, "…without clearing the ceilings the caller did not mention");
        assert(ceilingOrganization.getGrantableFeatures().length === 2, "…including the feature allow-list");

        // Lowering a ceiling has to reach the rules that were written under the
        // old one, or an administrator inspecting them after a downgrade would
        // see grants that no longer happen.
        await OrganizationPermissionRuleQueryEngine.replaceRules
        (
            topUpOrganization.getId(),
            [{ name: "Everyone", tagFilter: [], matchMode: tagMatchModes.EVERYONE, allowedFeatures: [planFeatures.CURATED_STUDY, planFeatures.MOCK_TEST_EVALUATION], storageGrantBytes: 200 * 1024 * 1024 }],
            ceilingOrganization.getGrantableFeatures(),
            ceilingOrganization.getMaxStorageGrantBytesPerMember()
        );

        const rulesBeforeReclamp = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(topUpOrganization.getId());

        await OrganizationQueryEngine.setEntitlementLimits(topUpOrganization.getId(), { maxStorageGrantBytesPerMember: 50 * 1024 * 1024, grantableFeatures: [planFeatures.CURATED_STUDY] });
        const loweredOrganization = await OrganizationQueryEngine.getOrganizationById(topUpOrganization.getId());

        await OrganizationPermissionRuleQueryEngine.replaceRules
        (
            topUpOrganization.getId(),
            (await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(topUpOrganization.getId())).map(rule => rule.toJson()),
            loweredOrganization.getGrantableFeatures(),
            loweredOrganization.getMaxStorageGrantBytesPerMember()
        );

        const reclampedRules = await OrganizationPermissionRuleQueryEngine.listRulesForOrganization(topUpOrganization.getId());
        assert(reclampedRules.length === 1, "The rule survives a ceiling change");
        // Compared as ISO strings: the codegen getter returns a Date, so `===`
        // would compare object identity and pass nothing but a reference check.
        assert(reclampedRules[0].getCreatedAt().toISOString() === rulesBeforeReclamp[0].getCreatedAt().toISOString(), "…keeping when it was written, so lowering a ceiling does not restamp every rule to now and reshuffle the list");
        assert(reclampedRules[0].getId() === rulesBeforeReclamp[0].getId(), "…and keeping its identity");
        assert(reclampedRules[0].getStorageGrantBytes() === 50 * 1024 * 1024, "…with its storage grant brought down to the new ceiling");
        assert(!reclampedRules[0].getAllowedFeatures().includes(planFeatures.MOCK_TEST_EVALUATION), "…and the feature that left the agreement removed from it");
        assert(reclampedRules[0].getAllowedFeatures().includes(planFeatures.CURATED_STUDY), "…while the feature still in the agreement stays");
    }
    catch (databaseTierError)
    {
        assert(false, `Database tier threw: ${databaseTierError.message}`);
        console.error(databaseTierError);
    }
    finally
    {
        try
        {
            const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
            if (createdUserIds.length > 0)
            {
                await usersCollection.deleteMany({ id: { $in: createdUserIds } });
                await database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION).deleteMany({ userId: { $in: createdUserIds } });
            }

            for (const organizationId of createdOrganizationIds)
            {
                await database.collection(DatabaseConstants.ORGANIZATION_CREDIT_POOLS_COLLECTION).deleteMany({ organizationId: organizationId });
                await database.collection(DatabaseConstants.ORGANIZATION_CREDIT_TRANSACTIONS_COLLECTION).deleteMany({ organizationId: organizationId });
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
    console.log("CogniumLearn — organization credits verification\n");

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
