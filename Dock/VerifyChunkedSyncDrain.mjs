/**
 * Verification harness for the chunked-sync drain.
 *
 * Run from the Dock directory:
 *     node VerifyChunkedSyncDrain.mjs
 *
 * What it protects:
 *
 *   1. THE RE-DELIVERY BUG. Every collection is pulled with an open-ended
 *      `serverUpdatedAt > lastSync`, but the cursor handed back when a pull is
 *      chunked is the SMALLEST overflow watermark. A collection that did not
 *      overflow therefore returned rows far above that cursor, and those rows
 *      matched `> cursor` again on the very next cycle — so they were re-sent
 *      on EVERY cycle of the drain. `remainingEntityCount` counted them a
 *      second time on top, which made the client's "X / Y items" denominator
 *      climb by the re-delivered count on every round trip instead of counting
 *      down. A returning device draining a real library watched the total grow
 *      until the user gave up.
 *
 *      The checks below drive the REAL /Sync handler through a whole drain and
 *      assert that (a) nothing except decks is ever delivered above the cursor,
 *      (b) every non-deck entity is delivered exactly once, and (c) nothing is
 *      lost.
 *
 *   2. THE CLIENT'S PROGRESS ARITHMETIC. SyncOrchestrator computes
 *      `total = processed + newThisChunk + remaining` from the server's
 *      numbers. runDrain below mirrors that formula (including the distinct
 *      entity-key set that stops re-delivered decks inflating `processed`) and
 *      asserts the total never grows across the drain and lands exactly on the
 *      real entity count. If either end of the contract regresses — the server
 *      double-counting, or the client counting raw payload lengths — the total
 *      starts climbing again and these fail.
 *
 *   3. THE UNCHUNKED FAST PATH. An account small enough to fit in one cycle
 *      must behave exactly as it did before: everything delivered, no trim, no
 *      `morePending`.
 *
 * Self-contained: the real endpoint runs against an in-memory stand-in for
 * MongoDB, so there is no Mongo, no Redis and no network. Nothing to opt into
 * and nothing to skip.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

const { entityTypes } = require("./Globals/Enumerations/EntityTypes");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");

// ── Caps mirrored from Sync.js ─────────────────────────────────────────
// Deliberately duplicated rather than exported: the expectations below are
// hand-computed from these numbers, so changing a cap in Sync.js without
// revisiting them fails here instead of silently weakening the checks.
const MAX_PULL_PER_COLLECTION = 200;

const TEST_USER_ID = "verify-drain-user";
const TEST_DEVICE_ID = "verify-drain-device";

let passedCount = 0;
let failedCount = 0;

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

function section(title)
{
    console.log(`\n${title}`);
    console.log("-".repeat(title.length));
}

// ──────────────────────────────────────────────────────────────────────
//  In-memory MongoDB stand-in
// ──────────────────────────────────────────────────────────────────────

/**
 * Supports exactly the query shapes Sync.js's pull phase issues: equality,
 * `$gt` on a Date, and `$in` on an array. Anything else is a hard error rather
 * than a silent mismatch, so a new query shape in the endpoint surfaces here.
 */
function documentMatchesFilter(document, filter)
{
    for (const fieldName of Object.keys(filter))
    {
        const expected = filter[fieldName];
        const actual = fieldName.includes(".")
            ? fieldName.split(".").reduce((value, key) => (value === undefined || value === null ? value : value[key]), document)
            : document[fieldName];

        if (expected !== null && typeof expected === "object" && !(expected instanceof Date))
        {
            const operatorNames = Object.keys(expected);
            for (const operatorName of operatorNames)
            {
                if (operatorName === "$gt")
                {
                    const boundary = expected.$gt instanceof Date ? expected.$gt.getTime() : expected.$gt;
                    const value = actual instanceof Date ? actual.getTime() : actual;
                    if (!(value > boundary))
                    {
                        return false;
                    }
                }
                else if (operatorName === "$in")
                {
                    if (!expected.$in.includes(actual))
                    {
                        return false;
                    }
                }
                else
                {
                    throw new Error(`Unsupported query operator ${operatorName} — extend the harness's matcher.`);
                }
            }
            continue;
        }

        if (expected instanceof Date)
        {
            const value = actual instanceof Date ? actual.getTime() : actual;
            if (value !== expected.getTime())
            {
                return false;
            }
            continue;
        }

        if (actual !== expected)
        {
            return false;
        }
    }

    return true;
}

class InMemoryCollection
{
    constructor(documents)
    {
        this.documents = documents;
    }

    find(filter)
    {
        const matched = this.documents.filter((document) => documentMatchesFilter(document, filter));
        let working = matched;

        const cursor =
        {
            sort: (specification) =>
            {
                const fieldName = Object.keys(specification)[0];
                const direction = specification[fieldName];
                working = [...working].sort((first, second) =>
                {
                    const firstValue = first[fieldName] instanceof Date ? first[fieldName].getTime() : first[fieldName];
                    const secondValue = second[fieldName] instanceof Date ? second[fieldName].getTime() : second[fieldName];
                    return (firstValue - secondValue) * direction;
                });
                return cursor;
            },
            limit: (count) =>
            {
                working = working.slice(0, count);
                return cursor;
            },
            toArray: async () => working.map((document) => ({ ...document })),
        };

        return cursor;
    }

    async countDocuments(filter)
    {
        return this.documents.filter((document) => documentMatchesFilter(document, filter)).length;
    }
}

class InMemoryDatabase
{
    constructor()
    {
        this.collectionsByName = new Map();
    }

    seed(collectionName, documents)
    {
        this.collectionsByName.set(collectionName, new InMemoryCollection(documents));
    }

    collection(collectionName)
    {
        if (!this.collectionsByName.has(collectionName))
        {
            this.collectionsByName.set(collectionName, new InMemoryCollection([]));
        }
        return this.collectionsByName.get(collectionName);
    }
}

// ──────────────────────────────────────────────────────────────────────
//  Wiring the real endpoint to the stand-in
// ──────────────────────────────────────────────────────────────────────

const activeDatabaseHolder = { database: null };

// Every collaborator is patched on its cached module object BEFORE Sync.js is
// required, so the endpoint's own top-level `require`s pick up the stand-ins.
const getUserModule = require("./Endpoints/Helpers/GetUser");
getUserModule.getUser = async () => ({ getId: () => TEST_USER_ID });

const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
DatabaseConnector.getDatabase = async () => activeDatabaseHolder.database;

const TaskManager = require("./Globals/Classes/Task/TaskManager");
TaskManager.getSyncLockState = async () => ({ bIsLocked: true, holderDeviceId: TEST_DEVICE_ID });

const StorageCreditAssessor = require("./Globals/Classes/Credits/StorageCreditAssessor");
StorageCreditAssessor.assess = async () => {};

const StorageQuotaEnforcer = require("./Globals/Classes/Storage/StorageQuotaEnforcer");
StorageQuotaEnforcer.isWithinQuota = async () => true;
StorageQuotaEnforcer.getLimitBytes = async () => Number.MAX_SAFE_INTEGER;

const LapsedPaidDeckReaper = require("./Globals/Classes/PaidDeck/LapsedPaidDeckReaper");
LapsedPaidDeckReaper.reapForUser = async () => {};

const SyncQueryEngine = require("./Globals/Classes/Database/SyncQueryEngine");
SyncQueryEngine.bulkUpsert = async () => {};
SyncQueryEngine.bulkRecordDeletions = async () => {};
SyncQueryEngine.pruneLegacyDeckFields = async () => {};
SyncQueryEngine.upsertSyncData = async () => {};
SyncQueryEngine.userHasAnyData = async () => true;
SyncQueryEngine.getDeletionsSince = async (userId, lastSyncTimestamp, limit = 0) =>
{
    const collection = activeDatabaseHolder.database.collection(DatabaseConstants.DELETIONS_COLLECTION);
    let matched = collection.documents
        .filter((document) => document.userId === userId && document.deletedAt.getTime() > lastSyncTimestamp)
        .sort((first, second) => first.deletedAt.getTime() - second.deletedAt.getTime());
    if (limit > 0)
    {
        matched = matched.slice(0, limit);
    }
    return matched.map((document) => ({ ...document }));
};
SyncQueryEngine.getDeletionsAtTimestamp = async (userId, timestampMilliseconds) =>
{
    const collection = activeDatabaseHolder.database.collection(DatabaseConstants.DELETIONS_COLLECTION);
    return collection.documents
        .filter((document) => document.userId === userId && document.deletedAt.getTime() === timestampMilliseconds)
        .map((document) => ({ ...document }));
};

const { handleSync } = require("./Endpoints/Sync/Sync");

/**
 * Drives one /Sync request against the real handler and returns the JSON body.
 */
async function postSync(lastSync)
{
    const request =
    {
        getBody: async () => ({ deviceId: TEST_DEVICE_ID, lastSync: lastSync, isLastChunk: true, changes: [] }),
    };

    let responseBody = null;
    let responseStatus = 200;
    const response =
    {
        set statusCode(value) { responseStatus = value; },
        get statusCode() { return responseStatus; },
        sendJson: (body) => { responseBody = body; },
        sendStatusCode: (code) => { responseStatus = code; },
    };

    await handleSync(request, response);

    if (responseBody === null)
    {
        throw new Error(`/Sync returned status ${responseStatus} with no body.`);
    }
    return responseBody;
}

// ──────────────────────────────────────────────────────────────────────
//  Fixture
// ──────────────────────────────────────────────────────────────────────

/**
 * Builds an account whose entities are INTERLEAVED in time across every
 * collection, which is what a real full-library push produces: SyncTransport
 * uploads in parallel chunks of 100 and each chunk gets its own server-side
 * write timestamp, so a deck, a card and a study material routinely share a
 * timestamp band. Interleaving is what exposes the bug — a collection whose
 * rows sit above another collection's overflow watermark is exactly the one
 * that used to be re-sent every cycle.
 */
function buildInterleavedAccount(counts)
{
    const database = new InMemoryDatabase();
    const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);

    const specifications =
    [
        { count: counts.decks,          collectionName: DatabaseConstants.DECKS_COLLECTION,              prefix: "deck"     },
        { count: counts.cards,          collectionName: DatabaseConstants.CARDS_COLLECTION,              prefix: "card"     },
        { count: counts.studyMaterials, collectionName: DatabaseConstants.STUDY_MATERIALS_COLLECTION,    prefix: "material" },
        { count: counts.mockTests,      collectionName: DatabaseConstants.MOCK_TESTS_COLLECTION,         prefix: "mock"     },
    ];

    const totalEntityCount = specifications.reduce((sum, specification) => sum + specification.count, 0);
    // Spread every entity of every collection over the same timestamp band so
    // no collection is neatly "older" than another.
    let writeIndex = 0;

    for (const specification of specifications)
    {
        const documents = [];
        for (let entityIndex = 0; entityIndex < specification.count; entityIndex++)
        {
            // Stride through the band rather than filling it sequentially.
            const timestampOffset = (writeIndex * 7919) % Math.max(1, totalEntityCount);
            writeIndex = writeIndex + 1;
            documents.push(
            {
                userId: TEST_USER_ID,
                serverUpdatedAt: new Date(baseTime + timestampOffset * 10),
                data: { id: `${specification.prefix}-${entityIndex}` },
            });
        }
        database.seed(specification.collectionName, documents);
    }

    const deletionDocuments = [];
    for (let deletionIndex = 0; deletionIndex < counts.deletions; deletionIndex++)
    {
        const timestampOffset = (writeIndex * 7919) % Math.max(1, totalEntityCount);
        writeIndex = writeIndex + 1;
        deletionDocuments.push(
        {
            userId: TEST_USER_ID,
            entityId: `deleted-card-${deletionIndex}`,
            entityType: entityTypes.CARD,
            deletedAt: new Date(baseTime + timestampOffset * 10),
        });
    }
    database.seed(DatabaseConstants.DELETIONS_COLLECTION, deletionDocuments);

    database.seed(DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION, []);
    database.seed(DatabaseConstants.CONTENT_OVERLAYS_COLLECTION, []);

    return { database, totalEntityCount, totalDeletionCount: counts.deletions };
}

// ──────────────────────────────────────────────────────────────────────
//  Drain driver — mirrors SyncOrchestrator's progress arithmetic exactly
// ──────────────────────────────────────────────────────────────────────

const MAX_DRAIN_CYCLES = 500;

async function runDrain()
{
    const cycles = [];

    // The client's drain state, one-for-one with SyncOrchestrator:
    //   #drainProcessedEntityKeys / #processedDrainEntities / #totalDrainEntities
    const processedEntityKeys = new Set();
    let processedDrainEntities = 0;
    let totalDrainEntities = 0;

    let lastSync = 0;

    for (let cycleIndex = 0; cycleIndex < MAX_DRAIN_CYCLES; cycleIndex++)
    {
        const responseBody = await postSync(lastSync);

        let newEntityCount = 0;
        const registerEntity = (entityType, entityId) =>
        {
            const entityKey = `${entityType}:${entityId}`;
            if (processedEntityKeys.has(entityKey))
            {
                return;
            }
            processedEntityKeys.add(entityKey);
            newEntityCount = newEntityCount + 1;
        };
        for (const change of responseBody.changes)
        {
            registerEntity(change.entityType, change.entityId);
        }
        for (const deletion of responseBody.deletions)
        {
            registerEntity(deletion.entityType, deletion.entityId);
        }

        const remainingEntities = typeof responseBody.remainingEntityCount === "number" ? responseBody.remainingEntityCount : 0;

        if (responseBody.morePending === true)
        {
            totalDrainEntities = processedDrainEntities + newEntityCount + remainingEntities;
            processedDrainEntities = processedDrainEntities + newEntityCount;
        }
        else
        {
            processedDrainEntities = processedDrainEntities + newEntityCount;
            totalDrainEntities = Math.max(processedDrainEntities, totalDrainEntities);
        }

        cycles.push(
        {
            cursorIn: lastSync,
            cursorOut: responseBody.serverTime,
            changes: responseBody.changes,
            deletions: responseBody.deletions,
            morePending: responseBody.morePending === true,
            remainingEntities: remainingEntities,
            newEntityCount: newEntityCount,
            processed: processedDrainEntities,
            total: totalDrainEntities,
        });

        lastSync = responseBody.serverTime;

        if (responseBody.morePending !== true)
        {
            return cycles;
        }
    }

    throw new Error(`Drain did not terminate within ${MAX_DRAIN_CYCLES} cycles — the cursor is not advancing.`);
}

// ──────────────────────────────────────────────────────────────────────
//  Checks
// ──────────────────────────────────────────────────────────────────────

async function runChunkedDrainChecks()
{
    section("Chunked drain over an interleaved library");

    const account = buildInterleavedAccount(
    {
        decks: 40,
        cards: 1000,
        studyMaterials: 60,
        mockTests: 30,
        deletions: 50,
    });
    activeDatabaseHolder.database = account.database;

    const cycles = await runDrain();

    assert(cycles.length > 1, `Library of ${account.totalEntityCount} entities drained across multiple cycles (${cycles.length})`);

    // ── The cursor must strictly advance, or the drain never ends ──────
    let bCursorAlwaysAdvanced = true;
    for (const cycle of cycles)
    {
        if (cycle.morePending && !(cycle.cursorOut > cycle.cursorIn))
        {
            bCursorAlwaysAdvanced = false;
        }
    }
    assert(bCursorAlwaysAdvanced, "Every chunked cycle advanced the cursor");

    // ── The trim: nothing except decks may be delivered above the cursor ──
    let aboveCursorNonDeckCount = 0;
    let aboveCursorDeletionCount = 0;
    for (const cycle of cycles)
    {
        if (!cycle.morePending)
        {
            continue;
        }
        for (const change of cycle.changes)
        {
            if (change.entityType === entityTypes.DECK)
            {
                continue;
            }
            const deliveredTimestamp = deliveredEntityTimestamp(account.database, change);
            if (deliveredTimestamp > cycle.cursorOut)
            {
                aboveCursorNonDeckCount = aboveCursorNonDeckCount + 1;
            }
        }
        for (const deletion of cycle.deletions)
        {
            const deletionTimestamp = deletionTimestampFor(account.database, deletion.entityId);
            if (deletionTimestamp > cycle.cursorOut)
            {
                aboveCursorDeletionCount = aboveCursorDeletionCount + 1;
            }
        }
    }
    assert(aboveCursorNonDeckCount === 0, `No non-deck entity delivered above the chunk cursor (found ${aboveCursorNonDeckCount})`);
    assert(aboveCursorDeletionCount === 0, `No deletion delivered above the chunk cursor (found ${aboveCursorDeletionCount})`);

    // ── Exactly-once delivery for everything the trim covers ───────────
    const deliveryCountByKey = new Map();
    for (const cycle of cycles)
    {
        for (const change of cycle.changes)
        {
            const entityKey = `${change.entityType}:${change.entityId}`;
            deliveryCountByKey.set(entityKey, (deliveryCountByKey.get(entityKey) || 0) + 1);
        }
        for (const deletion of cycle.deletions)
        {
            const entityKey = `deletion:${deletion.entityId}`;
            deliveryCountByKey.set(entityKey, (deliveryCountByKey.get(entityKey) || 0) + 1);
        }
    }

    let duplicatedNonDeckCount = 0;
    for (const [entityKey, deliveryCount] of deliveryCountByKey.entries())
    {
        if (deliveryCount > 1 && !entityKey.startsWith(`${entityTypes.DECK}:`))
        {
            duplicatedNonDeckCount = duplicatedNonDeckCount + 1;
        }
    }
    assert(duplicatedNonDeckCount === 0, `No non-deck entity was delivered more than once (found ${duplicatedNonDeckCount})`);

    // ── Nothing lost ───────────────────────────────────────────────────
    const deliveredEntityCount = [...deliveryCountByKey.keys()].filter((key) => !key.startsWith("deletion:")).length;
    const deliveredDeletionCount = [...deliveryCountByKey.keys()].filter((key) => key.startsWith("deletion:")).length;
    assert(deliveredEntityCount === account.totalEntityCount,
        `Every entity was delivered (${deliveredEntityCount} of ${account.totalEntityCount})`);
    assert(deliveredDeletionCount === account.totalDeletionCount,
        `Every deletion was delivered (${deliveredDeletionCount} of ${account.totalDeletionCount})`);

    // ── The progress total must never climb ────────────────────────────
    // This is the user-visible symptom: the "X / Y items" denominator grew on
    // every round trip. It may legitimately shrink (the first chunk's estimate
    // is the roughest) but it must never grow.
    let largestTotalIncrease = 0;
    for (let cycleIndex = 1; cycleIndex < cycles.length; cycleIndex++)
    {
        const increase = cycles[cycleIndex].total - cycles[cycleIndex - 1].total;
        if (increase > largestTotalIncrease)
        {
            largestTotalIncrease = increase;
        }
    }
    assert(largestTotalIncrease === 0,
        `The "X / Y items" total never grew across the drain (largest increase ${largestTotalIncrease})`);

    const finalCycle = cycles[cycles.length - 1];
    const expectedTotal = account.totalEntityCount + account.totalDeletionCount;
    assert(finalCycle.processed === expectedTotal,
        `Drain finished having counted every entity exactly once (${finalCycle.processed} of ${expectedTotal})`);
    assert(finalCycle.processed === finalCycle.total,
        `Progress landed on "X / X" (${finalCycle.processed} / ${finalCycle.total})`);

    // ── remainingEntityCount must be a true disjoint remainder ─────────
    let bRemainderAlwaysConsistent = true;
    for (let cycleIndex = 0; cycleIndex < cycles.length; cycleIndex++)
    {
        const cycle = cycles[cycleIndex];
        if (!cycle.morePending)
        {
            continue;
        }
        const stillToCome = expectedTotal - cycle.processed;
        if (cycle.remainingEntities !== stillToCome)
        {
            bRemainderAlwaysConsistent = false;
            console.log(`        cycle ${cycleIndex}: server said ${cycle.remainingEntities} remaining, actually ${stillToCome}`);
        }
    }
    assert(bRemainderAlwaysConsistent, "remainingEntityCount matched the true remainder on every chunked cycle");

    const expectedCycleCount = Math.ceil(1000 / MAX_PULL_PER_COLLECTION) + 1;
    assert(cycles.length <= expectedCycleCount,
        `Drain took no more cycles than the card backlog requires (${cycles.length} <= ${expectedCycleCount})`);
}

/**
 * Looks the delivered entity's stored serverUpdatedAt back up so the trim can
 * be checked against the cursor the same response handed out.
 */
function deliveredEntityTimestamp(database, change)
{
    const collectionNameByEntityType =
    {
        [entityTypes.DECK]:              DatabaseConstants.DECKS_COLLECTION,
        [entityTypes.CARD]:              DatabaseConstants.CARDS_COLLECTION,
        [entityTypes.STUDY_MATERIAL]:    DatabaseConstants.STUDY_MATERIALS_COLLECTION,
        [entityTypes.MOCK_TEST]:         DatabaseConstants.MOCK_TESTS_COLLECTION,
        [entityTypes.ASK_AI_POPUP_LINK]: DatabaseConstants.ASK_AI_POPUP_LINKS_COLLECTION,
        [entityTypes.CONTENT_OVERLAY]:   DatabaseConstants.CONTENT_OVERLAYS_COLLECTION,
    };
    const collection = database.collection(collectionNameByEntityType[change.entityType]);
    const document = collection.documents.find((candidate) => candidate.data.id === change.entityId);
    return document.serverUpdatedAt.getTime();
}

function deletionTimestampFor(database, entityId)
{
    const collection = database.collection(DatabaseConstants.DELETIONS_COLLECTION);
    const document = collection.documents.find((candidate) => candidate.entityId === entityId);
    return document.deletedAt.getTime();
}

async function runSingleCycleChecks()
{
    section("Small library — the unchunked path is untouched");

    const account = buildInterleavedAccount(
    {
        decks: 5,
        cards: 80,
        studyMaterials: 4,
        mockTests: 2,
        deletions: 3,
    });
    activeDatabaseHolder.database = account.database;

    const cycles = await runDrain();

    assert(cycles.length === 1, `A library under every cap drained in one cycle (took ${cycles.length})`);

    const onlyCycle = cycles[0];
    assert(onlyCycle.morePending === false, "morePending was false");
    assert(onlyCycle.changes.length === account.totalEntityCount,
        `All ${account.totalEntityCount} entities arrived in the single response (got ${onlyCycle.changes.length})`);
    assert(onlyCycle.deletions.length === account.totalDeletionCount,
        `All ${account.totalDeletionCount} deletions arrived in the single response (got ${onlyCycle.deletions.length})`);
    assert(onlyCycle.cursorOut > 0, "The cursor advanced past the newest delivered row");
}

async function runDeletionHeavyChecks()
{
    section("Deletion-heavy drain");

    // Enough tombstones to exercise the deletion trim against a cursor set by
    // the cards collection rather than by the deletions themselves.
    const account = buildInterleavedAccount(
    {
        decks: 10,
        cards: 600,
        studyMaterials: 10,
        mockTests: 0,
        deletions: 400,
    });
    activeDatabaseHolder.database = account.database;

    const cycles = await runDrain();

    const deliveredDeletionIds = new Set();
    let duplicateDeletionCount = 0;
    for (const cycle of cycles)
    {
        for (const deletion of cycle.deletions)
        {
            if (deliveredDeletionIds.has(deletion.entityId))
            {
                duplicateDeletionCount = duplicateDeletionCount + 1;
            }
            deliveredDeletionIds.add(deletion.entityId);
        }
    }

    assert(duplicateDeletionCount === 0, `No tombstone was re-delivered (found ${duplicateDeletionCount})`);
    assert(deliveredDeletionIds.size === account.totalDeletionCount,
        `Every tombstone arrived (${deliveredDeletionIds.size} of ${account.totalDeletionCount})`);

    let largestTotalIncrease = 0;
    for (let cycleIndex = 1; cycleIndex < cycles.length; cycleIndex++)
    {
        const increase = cycles[cycleIndex].total - cycles[cycleIndex - 1].total;
        if (increase > largestTotalIncrease)
        {
            largestTotalIncrease = increase;
        }
    }
    assert(largestTotalIncrease === 0, `The total never grew with tombstones in the mix (largest increase ${largestTotalIncrease})`);
}

async function main()
{
    console.log("CogniumLearn — chunked sync drain verification");

    await runChunkedDrainChecks();
    await runSingleCycleChecks();
    await runDeletionHeavyChecks();

    console.log("\n---------------------------------------------");
    console.log(`Passed: ${passedCount}   Failed: ${failedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((unexpectedError) =>
{
    console.error("Harness crashed:", unexpectedError);
    process.exit(1);
});
