/**
 * VerifyGenerationScopeThreading — harness for which LIBRARY a generation run
 * writes into, and which ACCOUNT owns the run.
 *
 * Run from the Dock directory:
 *     node VerifyGenerationScopeThreading.mjs
 *     VERIFY_GENERATION_SCOPE_DB=1 node VerifyGenerationScopeThreading.mjs
 *
 * Tier 1 is pure and always runs. The Mongo tier is opt-in behind the env flag.
 *
 * THE BUG THIS CLOSES. /Generate was half organization-aware: the entitlement
 * check resolved the organization scope, but persistence used the raw account
 * id, while /Sync reads under the scope key. A deck generated inside an
 * organization view therefore landed in the user's personal namespace and never
 * appeared in the view it was made from.
 *
 * What it protects now:
 *
 *   THE TWO IDS STAYING APART. persistenceScopeKey decides which library the
 *   decks appear in. personalUserId owns the task, the credits, the
 *   notifications and the resume snapshot — and provenance records it as
 *   generatedByUserId, which SourceVerificationRunner later uses as a task
 *   owner. A scope key there would create tasks owned by a namespace instead of
 *   a person, which nothing tracking a user's tasks would ever find.
 *
 *   A RESUME LANDING SOMEWHERE ELSE. The organization travels in the request
 *   BODY, not the X-Organization-Context header. TaskStateClient re-POSTs the
 *   saved payload while the header is re-stamped from whatever view is open at
 *   that later moment — so a header-carried choice would silently retarget a
 *   resumed run. The same reasoning covers the retry body.
 *
 *   AN ESTIMATE CACHE THAT THRASHES. Cost is scope-independent (credits are
 *   always the individual's), so the target library must not be part of the
 *   estimate cache key or every flip of the dropdown burns a rate-limited call.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const OrganizationScopeResolver = require("./Globals/Classes/Organization/OrganizationScopeResolver");
const SyncQueryEngine = require("./Globals/Classes/Database/SyncQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

const REPOSITORY_ROOT = path.join(currentDirectory, "..");
const GENERATE_PATH = path.join(currentDirectory, "Endpoints", "AutomaticGeneration", "Generate.js");
const MOVE_TO_DATABASE_PATH = path.join(currentDirectory, "Endpoints", "Helpers", "MoveToDatabase.js");
const ESTIMATE_DIALOG_PATH = path.join(
    REPOSITORY_ROOT, "Main", "Pages", "AutomaticGeneration", "Components", "GenerationEstimateDialog.js");

const TEST_PREFIX = "verify-generation-scope-";

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function assert(condition, description)
{
    if (condition)
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

function skip(description)
{
    skippedCount += 1;
    console.log(`  SKIP  ${description}`);
}

function section(title)
{
    console.log(`\n=== ${title} ===`);
}


// ── Tier 1: the scope key itself ───────────────────────────────────────────

function runScopeKeyTier()
{
    section("A scope key round-trips and is distinguishable from a personal one");

    const personalUserId = "user-abc";
    const organizationId = "org-77";

    const personalScopeKey = OrganizationScopeResolver.buildScopeKey(personalUserId, "");
    const organizationScopeKey = OrganizationScopeResolver.buildScopeKey(personalUserId, organizationId);

    assert(personalScopeKey === personalUserId, "an empty organization yields the bare account id");

    assert(
        OrganizationScopeResolver.buildScopeKey(personalUserId, null) === personalUserId
        && OrganizationScopeResolver.buildScopeKey(personalUserId, undefined) === personalUserId,
        "null and undefined behave the same as empty, so a missing field cannot invent a namespace",
    );

    assert(organizationScopeKey !== personalUserId, "an organization scope key differs from the personal one");

    assert(
        organizationScopeKey.startsWith(personalUserId),
        "the scope key still contains the account id, so a reader can see whose library it is",
    );

    assert(
        OrganizationScopeResolver.isOrganizationScopeKey(organizationScopeKey) === true,
        "an organization scope key is recognised as one",
    );

    assert(
        OrganizationScopeResolver.isOrganizationScopeKey(personalScopeKey) === false,
        "a personal scope key is NOT recognised as an organization one",
    );

    assert(
        OrganizationScopeResolver.buildScopeKey(personalUserId, "org-88") !== organizationScopeKey,
        "two organizations under one account get two different libraries",
    );
}


// ── Tier 1: the endpoint keeps the two ids apart ───────────────────────────

function runEndpointThreadingTier()
{
    section("The endpoint uses the scope key for storage and the account id for everything else");

    const generateSource = fs.readFileSync(GENERATE_PATH, "utf8");

    // Whitespace-collapsed copy for assertions about a multi-line CALL. Matching
    // those against the raw text couples the harness to the file's indentation
    // and line endings, so a reformat would report a boundary violation that had
    // not happened — a false alarm here is expensive, because the thing being
    // asserted is where a user's decks end up.
    const generateSourceCollapsed = generateSource.replace(/\s+/g, " ");

    assert(
        generateSource.includes("let persistenceScopeKey = OrganizationScopeResolver.buildScopeKey(personalUserId, resolvedOrganizationId)"),
        "the scope key is composed from the resolved organization",
    );

    // A run launched inside an administrator's simulated plan sandbox has to
    // stay in it, or its decks appear in the real library instead. Header-only
    // and never from the body: a resume must not be able to name a sandbox.
    assert(
        generateSource.includes("PlanViewScopeKey.build(personalUserId, resolvedPlanViewTierName)"),
        "a run launched inside a simulated plan sandbox is persisted into that sandbox",
    );

    assert(
        generateSource.includes('resolvedOrganizationId.length > 0 ? "" : headerScope.planViewTierName'),
        "...and an organization target always wins over it, so the two can never both apply",
    );

    assert(
        !generateSource.includes('body["planViewTierName"]') && !generateSource.includes('body["planView"]'),
        "the plan sandbox is NEVER read from the request body — a resume must not be able to retarget into one",
    );

    // The body must win over the header, or a resume after switching views
    // retargets the run.
    assert(
        generateSource.includes('body["organizationId"]'),
        "the organization is read from the request BODY",
    );

    assert(
        generateSource.includes("OrganizationScopeResolver.authoriseContext(personalUserId, requestedOrganizationId, user)"),
        "a body-supplied organization is re-authorised against stored membership, never trusted",
    );

    assert(
        generateSourceCollapsed.includes("moveToDatabase( persistenceScopeKey, mainTaskId,"),
        "moveToDatabase receives the SCOPE KEY as its first argument — the line that decides where decks appear",
    );

    assert(
        generateSourceCollapsed.includes("generalGenerationSettings, personalUserId, resolvedOrganizationId,"),
        "...and the account id and organization follow it, so provenance can still name who ran it",
    );

    assert(
        generateSource.includes("clearPartialCompletionOnDecks(persistenceScopeKey,"),
        "partial-completion clearing is scoped the same way, or it would look in the wrong library",
    );

    // Everything below is personal-keyed. A scope key in any of them orphans a
    // recovery path or bills the wrong ledger.
    const mustStayPersonal = [
        ["CreditPreflight.check(personalUserId", "the credit preflight charges the ACCOUNT"],
        ["PlanEntitlementGate.requireFeatureForRequest(request, personalUserId", "entitlement is checked against the account"],
        ["TaskManager.trackForUser(personalUserId", "task tracking is keyed to the account"],
        ["userId: personalUserId", "the task descriptor is owned by the account, not a namespace"],
    ];

    for (const [needle, description] of mustStayPersonal)
    {
        assert(generateSource.includes(needle), description);
    }

    assert(
        !generateSource.includes("TaskStateManager.save({ userId: persistenceScopeKey"),
        "the resume snapshot is saved against the account — a scope-keyed one would never be found again",
    );

    section("The choice survives a resume and a retry");

    assert(
        generateSource.includes("retryBody[\"organizationId\"] = organizationId"),
        "the retry body carries the organization forward",
    );

    assert(
        generateSourceCollapsed.includes("mockTestGeneration: mockTestGenerationSettingsJson, }, resolvedOrganizationId,"),
        "the retry body is built WITH the resolved organization, not without it",
    );

    // TaskStateManager.save spreads the whole body, so organizationId rides
    // along automatically — which is the payoff of carrying it in the body.
    assert(
        generateSource.includes("payload: body"),
        "the resume snapshot stores the whole body, so the organization is carried without extra plumbing",
    );

    section("A parent deck from another library cannot orphan the output");

    assert(
        generateSource.includes("SyncQueryEngine.getDeck(persistenceScopeKey, deckId)"),
        "the parent deck is looked up in the TARGET library",
    );

    assert(
        generateSource.includes('deckId = "0"'),
        "a parent deck missing from the target library falls back to that library's root rather than "
        + "building under an id that resolves to nothing there",
    );
}


function runMoveToDatabaseTier()
{
    section("Persistence treats the scope key as the owner and stamps the organization");

    const moveSource = fs.readFileSync(MOVE_TO_DATABASE_PATH, "utf8");

    for (const [needle, description] of [
        ["SyncQueryEngine.upsertDeck(persistenceScopeKey,", "decks are written under the scope key"],
        ["GeneratedEntityUpserter.upsertCards(persistenceScopeKey,", "cards are written under the scope key"],
        ["MockTestAssembler.upsertMockTests(persistenceScopeKey,", "mock tests are written under the scope key"],
        ["SyllabusFingerprintMatcher.findMergeTargetMap(persistenceScopeKey,", "merge targets are searched in the target library"],
        ["AiGeneratedTargetDeckStamper.markGenerationTargetDeck(persistenceScopeKey,", "the AI-generated stamp is applied in the target library"],
    ])
    {
        assert(moveSource.includes(needle), description);
    }

    assert(
        moveSource.includes("organizationId: resolvedOrganizationId"),
        "the deck carries the organization it was generated for",
    );

    // The one place inside MoveToDatabase that must NOT be the scope key.
    assert(
        moveSource.includes("userId: resolvedPersonalUserId"),
        "provenance records the ACCOUNT as generatedByUserId — SourceVerificationRunner uses that value "
        + "as a task owner, and a scope key there would own tasks nobody can find",
    );

    assert(
        !moveSource.includes("userId: persistenceScopeKey"),
        "...and never the scope key",
    );
}


function runEstimateCacheTier()
{
    section("The target library is not part of the cost estimate's cache key");

    const dialogSource = fs.readFileSync(ESTIMATE_DIALOG_PATH, "utf8");

    assert(
        dialogSource.includes("COST_NEUTRAL_SETTINGS_KEYS"),
        "the dialog names the fields that change destination but not price",
    );

    assert(
        dialogSource.includes('"organizationId"'),
        "organizationId is one of them — credits are always the individual's, so the library has no bearing "
        + "on the price and flipping the dropdown must not burn a rate-limited estimate call",
    );

    assert(
        dialogSource.includes("delete costRelevantSettings[costNeutralKey]"),
        "they are stripped before the fingerprint is taken",
    );
}


// ── Tier 2: Mongo ──────────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("A deck written to an organization scope is invisible in the personal one");

    if (process.env.VERIFY_GENERATION_SCOPE_DB !== "1")
    {
        skip("database tier (set VERIFY_GENERATION_SCOPE_DB=1 to run)");
        return;
    }

    const personalUserId = `${TEST_PREFIX}user-${Date.now()}`;
    const organizationId = `${TEST_PREFIX}org`;
    const organizationScopeKey = OrganizationScopeResolver.buildScopeKey(personalUserId, organizationId);
    const deckId = `${TEST_PREFIX}deck-${Date.now()}`;

    try
    {
        await SyncQueryEngine.upsertDeck(organizationScopeKey, {
            id: deckId,
            name: "Organisation Deck",
            parent: "0",
            additionalData: { organizationId: organizationId },
        });

        const deckInOrganizationScope = await SyncQueryEngine.getDeck(organizationScopeKey, deckId);
        const deckInPersonalScope = await SyncQueryEngine.getDeck(personalUserId, deckId);

        assert(deckInOrganizationScope !== null, "the deck is present in the organization's library");

        assert(
            deckInPersonalScope === null,
            "the SAME deck id is absent from the personal library — the two are separate namespaces, not "
            + "one library filtered two ways",
        );

        assert(
            deckInOrganizationScope !== null
            && (deckInOrganizationScope.additionalData || {}).organizationId === organizationId,
            "the stored deck names the organization it was generated for, without a reader having to "
            + "parse a scope key",
        );

        // The reverse direction: a personal deck must not leak into the org view.
        const personalDeckId = `${TEST_PREFIX}personal-${Date.now()}`;
        await SyncQueryEngine.upsertDeck(personalUserId, { id: personalDeckId, name: "Personal Deck", parent: "0" });

        assert(
            await SyncQueryEngine.getDeck(organizationScopeKey, personalDeckId) === null,
            "a personal deck is not visible from the organization's library either",
        );
    }
    finally
    {
        const database = await DatabaseConnector.getDatabase();
        await database.collection(DatabaseConstants.DECKS_COLLECTION).deleteMany({ userId: { $regex: `^${TEST_PREFIX}` } });
        console.log("  (fixtures removed)");
    }
}


async function main()
{
    console.log("Verifying generation scope threading\n");

    runScopeKeyTier();
    runEndpointThreadingTier();
    runMoveToDatabaseTier();
    runEstimateCacheTier();
    await runDatabaseTier();

    section("Summary");
    console.log(`  passed:  ${passedCount}`);
    console.log(`  failed:  ${failedCount}`);
    console.log(`  skipped: ${skippedCount}`);

    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((error) =>
{
    console.error("Harness crashed:", error);
    process.exit(1);
});
