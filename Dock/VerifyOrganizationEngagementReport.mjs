/**
 * VerifyOrganizationEngagementReport — harness for the organization engagement
 * report and the daily-activity rollup behind it.
 *
 * Run from the Dock directory:
 *     node VerifyOrganizationEngagementReport.mjs
 *     VERIFY_ENGAGEMENT_DB=1 node VerifyOrganizationEngagementReport.mjs
 *
 * Tier 1 is pure and always runs. The database tier is opt-in, following
 * VerifyPaidDeckPublishGate.
 *
 * What it protects, in the order the failures would hurt:
 *
 *   ATTRIBUTING ONE ORGANIZATION'S ACTIVITY TO ANOTHER. Content is keyed by
 *   scope key and licences by personal account id, so the join from member to
 *   their copies of an organization's decks crosses two key spaces. Getting it
 *   wrong does not error — it silently reports a student's work for institute A
 *   inside institute B's report, which is a privacy failure wearing the costume
 *   of a spreadsheet. Asserted in both directions.
 *
 *   COUNTING A SITTING AS FIVE. A curated analysis produces several materials
 *   sharing one batch tag. Counting materials rather than distinct batches
 *   would make a student who studied once look five times as engaged as one who
 *   did, and the number would still look plausible.
 *
 *   BILLING TICKS REPORTED AS THINGS THE STUDENT DID. Storage is a real charge
 *   and belongs in the spend report, but it is periodic — counting it as "uses"
 *   would inflate an engagement figure with something nobody chose to do.
 *
 *   A CHART THAT LIES BY BEING EMPTY. A member with no recorded history must
 *   render a page that says WHICH kind of nothing it is, never a blank grid.
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const UserDailyActivityQueryEngine = require("./Globals/Classes/Database/UserDailyActivityQueryEngine");
const CreditSpendCategoryNamer = require("./Globals/Classes/Organization/CreditSpendCategoryNamer");
const OrganizationEngagementReportBuilder = require("./Globals/Classes/Organization/OrganizationEngagementReportBuilder");
const { renderEngagementReportPdf } = require("./Endpoints/OrganizationAdmin/Reports/DownloadEngagementReport");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const { creditTransactionTypes } = require("./Globals/Enumerations/CreditTransactionTypes");
const { taskTypes } = require("./Globals/Enumerations/TaskTypes");
const { deckLicenseStatuses } = require("./Globals/Enumerations/DeckLicenseStatuses");
const { mockTestEvaluationStatuses } = require("./Globals/Enumerations/MockTestEvaluationStatuses");

const TEST_NAME_PREFIX = "verify-engagement-";

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

function buildDayUtc(daysAgo)
{
    const dayMilliseconds = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`).getTime();
    return new Date(dayMilliseconds - (daysAgo * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

// ── Tier 1: pure ───────────────────────────────────────────────────────────

function runDayBucketingTier()
{
    section("Days are bucketed in UTC, and validated before they become a key");

    assert(UserDailyActivityQueryEngine.isValidDayUtc("2026-08-07"), "A real day is accepted");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc("2026-13-01"), "Month 13 is refused");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc("2026-02-30"), "The 30th of February is refused — a Date would silently roll it to March");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc("07-08-2026"), "A non-ISO ordering is refused");
    assert(!UserDailyActivityQueryEngine.isValidDayUtc(20260807), "A number is refused");

    assert(
        UserDailyActivityQueryEngine.toDayUtc("2026-08-07T23:59:59.000Z") === "2026-08-07",
        "A moment late in the UTC day buckets to that day",
    );
    assert(
        UserDailyActivityQueryEngine.toDayUtc("2026-08-08T00:00:01.000Z") === "2026-08-08",
        "…and a moment just after midnight buckets to the next one",
    );
    assert(UserDailyActivityQueryEngine.toDayUtc("not a date") === "", "An unparseable value buckets to nothing rather than to today");
}

function runCategoryNamingTier()
{
    section("A charge is named the same way in both tables");

    assert(
        CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.TASK_CHARGE, metadata: { source: "AskAi" } }) === "Ask AI",
        "Ask AI is recognised by its source marker",
    );
    assert(
        CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.TASK_CHARGE, metadata: { taskType: taskTypes.GENERATE_FLASHCARDS } }) === "Generate flashcards",
        "A task type is humanised from the enum",
    );
    assert(
        CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.TASK_CHARGE, metadata: { taskType: 999999 } }) === "Other AI usage",
        "An unrecognised task is named rather than dropped — a feature added later must not vanish from a total",
    );
    assert(
        CreditSpendCategoryNamer.describe({ type: creditTransactionTypes.STORAGE_CHARGE }) === "Storage",
        "Storage is recognised",
    );

    section("Storage is priced but not counted");

    assert(
        !CreditSpendCategoryNamer.isInvokedAiFeature("Storage"),
        "Storage is excluded from usage counts — it is billed periodically, so counting it reports billing ticks as things the student did",
    );
    assert(CreditSpendCategoryNamer.isInvokedAiFeature("Ask AI"), "An invoked feature is counted");
    assert(CreditSpendCategoryNamer.isInvokedAiFeature("Other AI usage"), "…including one whose name we did not recognise");
}

// ── Tier 2: database ───────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("The rollup and the report (database)");

    if (process.env.VERIFY_ENGAGEMENT_DB !== "1")
    {
        skip("Database tier — set VERIFY_ENGAGEMENT_DB=1 to run it");
        return;
    }

    let database = null;

    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`Database tier — could not connect: ${connectionError.message}`);
        return;
    }

    if (!database)
    {
        skip("Database tier — no database available");
        return;
    }

    const uniqueSuffix = Date.now();
    const organizationId = `${TEST_NAME_PREFIX}org-${uniqueSuffix}`;
    const otherOrganizationId = `${TEST_NAME_PREFIX}other-org-${uniqueSuffix}`;
    const memberEmail = `${TEST_NAME_PREFIX}member-${uniqueSuffix}@example.test`;
    const memberUserId = `${TEST_NAME_PREFIX}user-${uniqueSuffix}`;
    const scopeKey = `${memberUserId}::org:${organizationId}`;

    const organizationDeckId = `${TEST_NAME_PREFIX}deck-${uniqueSuffix}`;
    const otherOrganizationDeckId = `${TEST_NAME_PREFIX}other-deck-${uniqueSuffix}`;

    const activityCollection = database.collection(DatabaseConstants.USER_DAILY_ACTIVITY_COLLECTION);
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const licensesCollection = database.collection(DatabaseConstants.DECK_LICENSES_COLLECTION);
    const membersCollection = database.collection(DatabaseConstants.ORGANIZATION_MEMBERS_COLLECTION);
    const usersCollection = database.collection(DatabaseConstants.USERS_COLLECTION);
    const cardsCollection = database.collection(DatabaseConstants.CARDS_COLLECTION);
    const studyMaterialsCollection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
    const mockTestsCollection = database.collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
    const transactionsCollection = database.collection(DatabaseConstants.CREDIT_TRANSACTIONS_COLLECTION);

    try
    {
        // ── The rollup ────────────────────────────────────────────────────
        section("Daily rollup");

        const todayUtc = buildDayUtc(0);

        await UserDailyActivityQueryEngine.recordDailyUsage
        ({
            scopeKey: scopeKey, accountUserId: memberUserId, organizationId: organizationId,
            dayUtc: todayUtc, counters: { cardsStudied: 5, studyMaterialsViewed: 2 },
        });
        await UserDailyActivityQueryEngine.recordDailyUsage
        ({
            scopeKey: scopeKey, accountUserId: memberUserId, organizationId: organizationId,
            dayUtc: todayUtc, counters: { cardsStudied: 3 },
        });

        const rolledUp = await activityCollection.findOne({ scopeKey: scopeKey, dayUtc: todayUtc });

        assert(rolledUp !== null, "A day's usage is recorded");
        assert(rolledUp.counters.cardsStudied === 8, `Two reports for one day accumulate (got ${rolledUp?.counters?.cardsStudied})`);
        assert(rolledUp.counters.studyMaterialsViewed === 2, "…each counter independently");
        assert(rolledUp.source === "CLIENT_REPORTED", "The row records that it was device-reported, so a reader of the raw data knows");
        assert(rolledUp.accountUserId === memberUserId, "The personal account id is carried, so the report can cross the key spaces");

        const bRecordedNothing = await UserDailyActivityQueryEngine.recordDailyUsage
        ({
            scopeKey: scopeKey, accountUserId: memberUserId, organizationId: organizationId,
            dayUtc: todayUtc, counters: { cardsStudied: 0 },
        });

        assert(bRecordedNothing === false, "An all-zero report writes nothing — 'did nothing' and 'reported nothing' must stay distinguishable");

        assert(
            await UserDailyActivityQueryEngine.recordDailyUsage({ scopeKey: scopeKey, dayUtc: "2026-02-30", counters: { cardsStudied: 1 } }) === false,
            "An invalid day is refused rather than creating a row nothing reads",
        );

        assert(
            await UserDailyActivityQueryEngine.findEarliestRecordedDay(organizationId) === todayUtc,
            "The earliest recorded day is reported, so the report can say when device reporting began",
        );

        // ── The join ──────────────────────────────────────────────────────
        section("Org-deck scoping and the namespace boundary");

        await paidDecksCollection.insertMany
        ([
            { id: organizationDeckId, title: "Org deck", audienceOrganizationId: organizationId, isPublished: true },
            { id: otherOrganizationDeckId, title: "Other org deck", audienceOrganizationId: otherOrganizationId, isPublished: true },
        ]);

        await licensesCollection.insertOne
        ({
            id: `${TEST_NAME_PREFIX}license-${uniqueSuffix}`,
            userId: memberUserId, deckId: organizationDeckId,
            status: deckLicenseStatuses.ACTIVE, scopeKey: scopeKey,
            expiresAt: new Date(0).toISOString(),
        });

        await membersCollection.insertOne({ organizationId: organizationId, email: memberEmail, userId: memberUserId, addedAt: new Date(), tags: [], attributes: {} });
        await usersCollection.insertOne({ id: memberUserId, displayName: "Test Member", additionalData: { email: memberEmail, credits: 10 } });

        // Content in the ORG scope, tagged with the org's deck.
        await studyMaterialsCollection.insertMany
        ([
            {
                userId: scopeKey, serverUpdatedAt: new Date(),
                data: { id: `${TEST_NAME_PREFIX}sm1-${uniqueSuffix}`, deckId: "d", lifecycle: { views: 4 },
                    additionalData: { paidDeckId: organizationDeckId, bCurated: true, generatedForAnalysisAt: `${buildDayUtc(3)}T10:00:00.000Z`, readAt: `${buildDayUtc(3)}T11:00:00.000Z` } },
            },
            {
                // Same batch tag — one sitting, not two iterations.
                userId: scopeKey, serverUpdatedAt: new Date(),
                data: { id: `${TEST_NAME_PREFIX}sm2-${uniqueSuffix}`, deckId: "d", lifecycle: { views: 1 },
                    additionalData: { paidDeckId: organizationDeckId, bCurated: true, generatedForAnalysisAt: `${buildDayUtc(3)}T10:00:00.000Z`, readAt: `${buildDayUtc(3)}T11:30:00.000Z` } },
            },
            {
                // PERSONAL scope — must never appear in the organization's report.
                userId: memberUserId, serverUpdatedAt: new Date(),
                data: { id: `${TEST_NAME_PREFIX}sm3-${uniqueSuffix}`, deckId: "d", lifecycle: { views: 99 }, additionalData: {} },
            },
            {
                // ANOTHER organization's deck, in this member's scope.
                userId: scopeKey, serverUpdatedAt: new Date(),
                data: { id: `${TEST_NAME_PREFIX}sm4-${uniqueSuffix}`, deckId: "d", lifecycle: { views: 50 },
                    additionalData: { paidDeckId: otherOrganizationDeckId } },
            },
        ]);

        await mockTestsCollection.insertOne
        ({
            userId: scopeKey, serverUpdatedAt: new Date(),
            data: { id: `${TEST_NAME_PREFIX}mt1-${uniqueSuffix}`, deckId: "d",
                additionalData: { paidDeckId: organizationDeckId },
                history:
                [
                    { attemptDate: `${buildDayUtc(2)}T09:00:00.000Z`, evaluationStatus: mockTestEvaluationStatuses.COMPLETED },
                    { attemptDate: `${buildDayUtc(1)}T09:00:00.000Z`, evaluationStatus: mockTestEvaluationStatuses.COMPLETED },
                    // Not completed — not a test taken.
                    { attemptDate: `${buildDayUtc(1)}T10:00:00.000Z`, evaluationStatus: mockTestEvaluationStatuses.NOT_STARTED },
                ] },
        });

        await transactionsCollection.insertMany
        ([
            { referenceKey: `${TEST_NAME_PREFIX}t1-${uniqueSuffix}`, userId: memberUserId, type: creditTransactionTypes.TASK_CHARGE, amount: -1, status: "applied", metadata: { source: "AskAi" }, createdAt: new Date() },
            { referenceKey: `${TEST_NAME_PREFIX}t2-${uniqueSuffix}`, userId: memberUserId, type: creditTransactionTypes.TASK_CHARGE, amount: -1, status: "applied", metadata: { source: "AskAi" }, createdAt: new Date() },
            { referenceKey: `${TEST_NAME_PREFIX}t3-${uniqueSuffix}`, userId: memberUserId, type: creditTransactionTypes.STORAGE_CHARGE, amount: -1, status: "applied", metadata: {}, createdAt: new Date() },
        ]);

        const report = await OrganizationEngagementReportBuilder.build
        ({
            getId: () => organizationId,
            getName: () => "Verify Institute",
        });

        assert(report.rows.length === 1, `The member appears once (got ${report.rows.length})`);

        const memberRow = report.rows[0];

        assert(memberRow.bHoldsOrganizationDeck === true, "The member is recognised as holding one of the organization's decks");
        assert(
            memberRow.engagement.studyMaterialsViewed.total === 5,
            `Only the organization's own materials are counted — 4 + 1, not the personal 99 or the other org's 50 (got ${memberRow.engagement.studyMaterialsViewed.total})`,
        );
        assert(
            memberRow.engagement.curatedStudyIterations.total === 1,
            `Two materials sharing one batch tag are ONE iteration (got ${memberRow.engagement.curatedStudyIterations.total})`,
        );
        assert(
            memberRow.engagement.mockTestsTaken.total === 2,
            `Only completed attempts count (got ${memberRow.engagement.mockTestsTaken.total})`,
        );
        assert(
            memberRow.engagement.cardsStudied.total === 8,
            `Cards studied comes from the device rollup (got ${memberRow.engagement.cardsStudied.total})`,
        );
        assert(
            memberRow.engagement.cardsStudied.measurement === "DEVICE_REPORTED"
                && memberRow.engagement.mockTestsTaken.measurement === "OBSERVED",
            "Each feature carries whether it was observed or asserted",
        );
        assert(
            memberRow.aiUsage.totalsByCategory["Ask AI"] === 2,
            `AI uses are counted (got ${memberRow.aiUsage.totalsByCategory["Ask AI"]})`,
        );
        assert(
            memberRow.aiUsage.totalsByCategory.Storage === undefined,
            "…and storage is not among them",
        );
        assert(
            report.scopeDisclaimer.length > 0 && report.measurementDisclaimer.length > 0,
            "Both disclaimers travel on the report rather than being left to the renderer to remember",
        );

        // ── The render ────────────────────────────────────────────────────
        section("The PDF actually renders, with a page per member");

        const workingDirectory = path.join(os.tmpdir(), `verify-engagement-${crypto.randomBytes(6).toString("hex")}`);
        await fs.promises.mkdir(workingDirectory, { recursive: true });

        const reportJsonPath = path.join(workingDirectory, "engagement.json");
        const outputPdfPath = path.join(workingDirectory, "EngagementReport.pdf");

        try
        {
            await fs.promises.writeFile(reportJsonPath, JSON.stringify(report), "utf8");
            await renderEngagementReportPdf(reportJsonPath, outputPdfPath);

            const pdfBuffer = await fs.promises.readFile(outputPdfPath);
            const pdfText = pdfBuffer.toString("latin1");

            assert(pdfBuffer.subarray(0, 5).toString("latin1") === "%PDF-", "The renderer produced a PDF");
            assert(pdfBuffer.length > 2000, `…of a plausible size (${pdfBuffer.length} bytes)`);

            // The per-member page is the feature. A PDF missing its outline
            // entries and link destinations would still be a valid PDF, so
            // "it rendered" is not enough to say the feature works.
            assert(pdfText.includes("/Outlines"), "It carries a bookmark outline");
            assert(
                (pdfText.match(/\/Dest \[ \d+ 0 R \/Fit \]/g) || []).length >= report.rows.length,
                "…and at least one internal destination per member, so every row's link lands somewhere",
            );
        }
        catch (renderError)
        {
            if (String(renderError.message).includes("not installed on this server"))
            {
                skip(`Render proof — ${renderError.message}`);
            }
            else
            {
                failedCount += 1;
                console.log(`  FAIL  The renderer threw: ${renderError.message}`);
            }
        }
        finally
        {
            await fs.promises.rm(workingDirectory, { recursive: true, force: true });
        }
    }
    catch (databaseTierError)
    {
        failedCount += 1;
        console.log(`  FAIL  Database tier threw: ${databaseTierError.message}`);
        console.log(databaseTierError.stack);
    }
    finally
    {
        const prefixFilter = { $regex: `^${TEST_NAME_PREFIX}` };

        await activityCollection.deleteMany({ scopeKey: prefixFilter });
        await paidDecksCollection.deleteMany({ id: prefixFilter });
        await licensesCollection.deleteMany({ id: prefixFilter });
        await membersCollection.deleteMany({ organizationId: prefixFilter });
        await usersCollection.deleteMany({ id: prefixFilter });
        await cardsCollection.deleteMany({ userId: prefixFilter });
        await studyMaterialsCollection.deleteMany({ userId: prefixFilter });
        await mockTestsCollection.deleteMany({ userId: prefixFilter });
        await transactionsCollection.deleteMany({ referenceKey: prefixFilter });
    }
}

async function main()
{
    console.log("CogniumLearn — organization engagement report verification\n");

    runDayBucketingTier();
    runCategoryNamingTier();
    await runDatabaseTier();

    console.log(`\nPassed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
