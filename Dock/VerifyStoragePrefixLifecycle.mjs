/**
 * End-to-end verification harness for the object-storage prefix lifecycle —
 * every prefix a user action writes to, and the record that guarantees it is
 * eventually deleted.
 *
 * Run from the Dock directory:
 *     node VerifyStoragePrefixLifecycle.mjs
 *
 * It covers the three prefixes that were written by user action and deleted by
 * nothing:
 *
 *   Tasks/<mainTaskId>/                              generation staging. Purged
 *       eagerly by moveToDatabase on the success path only, so a failed,
 *       abandoned or restart-orphaned run left staged flashcards, study
 *       material, worker logs and figure crops of the uploaded book behind.
 *
 *   Tasks/<evaluationTaskId>/MockTestEvaluations/    the candidate's answers and
 *       the question text they answered. No registration and no sweep: the
 *       generation cleanup never runs for an evaluation task.
 *
 *   CreditDealInvoices/<dealId>/                     admin-authored commercial
 *       records with no stated retention period at all.
 *
 * All three now register with EphemeralUploadRegistry, which the existing
 * reaper already sweeps. The checks below assert the registration happens, that
 * the eager purges clear the record as well as the objects, and — the part that
 * matters most — that the retention windows stay ordered against the two other
 * clocks a generation run depends on.
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks driving the real registry and the real
 *      endpoint helpers with monkeypatched Persistence / database static seams.
 *
 *   2. DB (opt-in: VERIFY_PREFIX_DB=1) — drives the real EphemeralUploadRegistry
 *      against the configured MongoDB with throwaway prefixes, exercising
 *      register / findDue / purgeAllForUser and cleaning up afterwards.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const EphemeralUploadRegistry = require("./Globals/Classes/Content/EphemeralUploadRegistry");
const GenerationStagingPolicy = require("./Globals/Classes/Content/GenerationStagingPolicy");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const PersistenceConstants = require("./Globals/Constants/PersistenceConstants");
const TaskStateManager = require("./Globals/Classes/Task/TaskStateManager");
const Persistence = require("./Globals/Classes/Persistence");
const { ephemeralUploadKinds } = require("./Globals/Enumerations/EphemeralUploadKinds");

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

function heading(title)
{
    console.log("");
    console.log(title);
}

const originalImplementations =
{
    persistenceList: Persistence.list,
    persistenceDelete: Persistence.delete,
    getDatabase: DatabaseConnector.getDatabase
};

function restoreImplementations()
{
    Persistence.list = originalImplementations.persistenceList;
    Persistence.delete = originalImplementations.persistenceDelete;
    DatabaseConnector.getDatabase = originalImplementations.getDatabase;
}

/**
 * An in-memory stand-in for the ephemeralUploads collection plus object
 * storage, so the real registry can be driven without either service.
 */
function buildRecorder(configuration = {})
{
    const recorder =
    {
        registrations: new Map(),
        storedObjects: [...(configuration.storedObjects || [])],
        deletedPaths: [],
        failingPaths: configuration.failingPaths || []
    };

    Persistence.list = async (prefix) =>
        recorder.storedObjects.filter(storedObject => storedObject.startsWith(prefix));

    Persistence.delete = async (filePath) =>
    {
        if (recorder.failingPaths.includes(filePath))
        {
            throw new Error(`simulated storage failure for ${filePath}`);
        }
        recorder.deletedPaths.push(filePath);
        recorder.storedObjects = recorder.storedObjects.filter(storedObject => storedObject !== filePath);
    };

    const collection =
    {
        updateOne: async (filter, update, options) =>
        {
            const existing = recorder.registrations.get(filter.storagePrefix) || {};
            recorder.registrations.set(filter.storagePrefix, {
                ...existing,
                ...(options && options.upsert && !recorder.registrations.has(filter.storagePrefix) ? update.$setOnInsert : {}),
                ...update.$set,
                storagePrefix: filter.storagePrefix
            });
        },
        deleteOne: async (filter) => { recorder.registrations.delete(filter.storagePrefix); },
        find: (filter) => (
        {
            limit: () => ({ toArray: async () => [...recorder.registrations.values()].filter(record =>
            {
                if (filter.expiresAt && typeof filter.expiresAt.$lte === "number")
                {
                    return record.expiresAt <= filter.expiresAt.$lte;
                }
                return true;
            }) }),
            toArray: async () => [...recorder.registrations.values()].filter(record =>
                filter.userId === undefined || record.userId === filter.userId),
            project: () => ({ toArray: async () => [...recorder.registrations.values()] })
        })
    };

    DatabaseConnector.getDatabase = async () => ({ collection: () => collection });

    return recorder;
}

// ── Retention window ordering ─────────────────────────────────────────────
async function verifyRetentionWindowsAreOrdered()
{
    heading("Retention windows are ordered against the clocks they depend on");

    assert(
        DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS > DatabaseConstants.TASK_STATES_TTL_DAYS,
        "generation staging outlives the resumable-snapshot TTL, so a resumable run keeps its staging",
    );

    // OrphanedGenerationReconciler reads an EMPTY task folder as proof the run
    // succeeded, and only reaches that inference while the task blob is still
    // in Redis. If the reaper could empty a failed run's folder inside that
    // window, the reconciler would report a phantom success.
    const taskBlobTtlDays = (5 * 60 * 60) / (24 * 60 * 60);
    assert(
        DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS > taskBlobTtlDays,
        "generation staging outlives the 5h task-blob TTL, so the reaper cannot fake a successful run",
    );

    assert(
        DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS > 0,
        "the evaluation staging window is a real window, not zero",
    );

    assert(
        DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS <= DatabaseConstants.ANSWER_SHEET_RETENTION_DAYS,
        "evaluation staging is not kept longer than the answer sheet it grades",
    );

    assert(
        DatabaseConstants.DEAL_INVOICE_RETENTION_DAYS >= 8 * 365,
        "deal invoices are kept at least the eight years the Companies Act requires of books of account",
    );
}

// ── Registration coverage ─────────────────────────────────────────────────
async function verifyEveryKindIsDistinct()
{
    heading("Every upload kind is a distinct enum value");

    const kindValues = Object.values(ephemeralUploadKinds);
    assert(new Set(kindValues).size === kindValues.length, "no two upload kinds share a value");
    assert(typeof ephemeralUploadKinds.GENERATION_TASK_STAGING === "number", "GENERATION_TASK_STAGING exists");
    assert(typeof ephemeralUploadKinds.MOCK_TEST_EVALUATION === "number", "MOCK_TEST_EVALUATION exists");
    assert(typeof ephemeralUploadKinds.DEAL_INVOICE === "number", "DEAL_INVOICE exists");
}

async function verifyRegistrationRecordsTheWindow()
{
    heading("Registration books a real deletion record");

    const recorder = buildRecorder();
    const nowMilliseconds = Date.now();

    const bRegistered = await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/main-task-1/",
        kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
        userId: "user-one",
        retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
        metadata: { mainTaskId: "main-task-1" },
    });

    assert(bRegistered === true, "the registration reports success");

    const record = recorder.registrations.get("Tasks/main-task-1/");
    assert(record !== undefined, "a record exists for the prefix");
    assert(record.kind === ephemeralUploadKinds.GENERATION_TASK_STAGING, "the record carries the upload kind");
    assert(record.userId === "user-one", "the record carries the owner, so account deletion can reach it");

    const expectedExpiry = nowMilliseconds + (DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    assert(Math.abs(record.expiresAt - expectedExpiry) < 5000, "the expiry matches the configured window");

    restoreImplementations();
}

async function verifyResumeRefreshesRatherThanDuplicates()
{
    heading("A resumed run refreshes its window instead of stacking records");

    const recorder = buildRecorder();

    for (let attemptIndex = 0; attemptIndex < 3; attemptIndex = attemptIndex + 1)
    {
        await EphemeralUploadRegistry.register
        ({
            storagePrefix: "Tasks/main-task-1/",
            kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
            userId: "user-one",
            retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
            metadata: { mainTaskId: "main-task-1" },
        });
    }

    assert(recorder.registrations.size === 1, "three registrations of one prefix leave one record");

    restoreImplementations();
}

// ── Eager purge clears objects AND the record ─────────────────────────────
async function verifyEagerPurgeClearsTheRecord()
{
    heading("An eager purge removes the objects and the record together");

    const recorder = buildRecorder
    ({
        storedObjects:
        [
            "Tasks/main-task-1/Flashcards/0.json",
            "Tasks/main-task-1/StudyMaterials/0.json",
            "Tasks/main-task-1/Worker_1.log",
            "Tasks/other-task/Flashcards/0.json"
        ]
    });

    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/main-task-1/",
        kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
        userId: "user-one",
        retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
    });

    const removedCount = await EphemeralUploadRegistry.purgePrefix("Tasks/main-task-1/");

    assert(removedCount === 3, "every object under the prefix is removed");
    assert(recorder.registrations.size === 0, "the record is dropped, so the reaper stops re-listing an empty prefix");
    assert(recorder.storedObjects.includes("Tasks/other-task/Flashcards/0.json"), "a neighbouring run's staging is untouched");

    restoreImplementations();
}

async function verifyFailedPurgeKeepsTheRecordForRetry()
{
    heading("A failed purge keeps its record so the reaper retries");

    const recorder = buildRecorder
    ({
        storedObjects: ["Tasks/main-task-1/a.json", "Tasks/main-task-1/b.json"],
        failingPaths: ["Tasks/main-task-1/b.json"]
    });

    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/main-task-1/",
        kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
        userId: "user-one",
        retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
    });

    await EphemeralUploadRegistry.purgePrefix("Tasks/main-task-1/");

    assert(recorder.registrations.size === 1, "the record survives a partial purge");
    assert(recorder.storedObjects.includes("Tasks/main-task-1/b.json"), "the object that would not delete is still there to retry");

    restoreImplementations();
}

// ── Due-sweep and account deletion reach the new kinds ────────────────────
async function verifyExpiredPrefixesBecomeDue()
{
    heading("An elapsed window makes a prefix due for the reaper");

    buildRecorder();

    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/evaluation-task-1/MockTestEvaluations/",
        kind: ephemeralUploadKinds.MOCK_TEST_EVALUATION,
        userId: "user-one",
        retentionDays: DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS,
    });

    const beforeExpiry = Date.now() + (DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS * 24 * 60 * 60 * 1000) - 60_000;
    const afterExpiry = Date.now() + (DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS * 24 * 60 * 60 * 1000) + 60_000;

    const notYetDue = await EphemeralUploadRegistry.findDue(beforeExpiry, 500);
    assert(notYetDue.length === 0, "the prefix is not due before its window elapses");

    const due = await EphemeralUploadRegistry.findDue(afterExpiry, 500);
    assert(due.length === 1, "the prefix is due once its window elapses");
    assert(due[0].storagePrefix === "Tasks/evaluation-task-1/MockTestEvaluations/", "the due record names the right prefix");

    restoreImplementations();
}

async function verifyAccountDeletionReachesGenerationStaging()
{
    heading("Account deletion reaches the newly registered prefixes");

    const recorder = buildRecorder
    ({
        storedObjects:
        [
            "Tasks/main-task-1/Flashcards/0.json",
            "Tasks/evaluation-task-1/MockTestEvaluations/AttemptInput.json",
            "CreditDealInvoices/deal-1/invoice.pdf"
        ]
    });

    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/main-task-1/",
        kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
        userId: "user-one",
        retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
    });
    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "Tasks/evaluation-task-1/MockTestEvaluations/",
        kind: ephemeralUploadKinds.MOCK_TEST_EVALUATION,
        userId: "user-one",
        retentionDays: DatabaseConstants.MOCK_TEST_EVALUATION_RETENTION_DAYS,
    });
    await EphemeralUploadRegistry.register
    ({
        storagePrefix: "CreditDealInvoices/deal-1/",
        kind: ephemeralUploadKinds.DEAL_INVOICE,
        userId: null,
        retentionDays: DatabaseConstants.DEAL_INVOICE_RETENTION_DAYS,
    });

    const purgedPrefixCount = await EphemeralUploadRegistry.purgeAllForUser("user-one");

    assert(purgedPrefixCount === 2, "both of the user's prefixes are purged");
    assert(!recorder.storedObjects.includes("Tasks/main-task-1/Flashcards/0.json"), "an abandoned generation run no longer outlives the account");
    assert(!recorder.storedObjects.includes("Tasks/evaluation-task-1/MockTestEvaluations/AttemptInput.json"), "the graded attempt staging no longer outlives the account");
    assert(recorder.storedObjects.includes("CreditDealInvoices/deal-1/invoice.pdf"),
        "the deal invoice survives, because a commercial record is not the counterparty's to erase");

    restoreImplementations();
}

// ── Call-site wiring ──────────────────────────────────────────────────────
async function verifyCallSitesAreWired()
{
    heading("Every producer registers its prefix");

    const fileSystem = require("fs");

    const generateSource = fileSystem.readFileSync(path.join(currentDirectory, "Endpoints", "AutomaticGeneration", "Generate.js"), "utf8");
    assert(generateSource.includes("ephemeralUploadKinds.GENERATION_TASK_STAGING"), "Generate.js registers the run's staging folder");
    // Anchored on the first pipeline execution rather than on a line number:
    // the whole point of registering at run start is that it precedes anything
    // capable of writing staged output, and that ordering is what a later edit
    // could silently break.
    assert(
        generateSource.indexOf("EphemeralUploadRegistry.register") < generateSource.indexOf("TaskManager.execute("),
        "the registration happens before the pipeline runs, so no staging can be written unregistered",
    );
    assert(
        generateSource.indexOf("TaskManager.setTask(mainTaskDescriptor)") < generateSource.indexOf("EphemeralUploadRegistry.register"),
        "the registration follows the main task being created, so it records a real run id",
    );

    const evaluateSource = fileSystem.readFileSync(path.join(currentDirectory, "Endpoints", "MockTest", "EvaluateAttempt.js"), "utf8");
    assert(evaluateSource.includes("ephemeralUploadKinds.MOCK_TEST_EVALUATION"), "EvaluateAttempt.js registers the evaluation prefix");
    assert(
        evaluateSource.indexOf("EphemeralUploadRegistry.register") < evaluateSource.indexOf("Persistence.write(attemptPersistencePath"),
        "the registration happens before the attempt payload is written",
    );
    assert(evaluateSource.includes("purgeEvaluationStaging"), "EvaluateAttempt.js purges the staging eagerly once grades are applied");

    const invoiceSource = fileSystem.readFileSync(path.join(currentDirectory, "Endpoints", "Admin", "Deals", "UploadDealInvoice.js"), "utf8");
    assert(invoiceSource.includes("ephemeralUploadKinds.DEAL_INVOICE"), "UploadDealInvoice.js registers the invoice folder");

    const moveSource = fileSystem.readFileSync(path.join(currentDirectory, "Endpoints", "Helpers", "MoveToDatabase.js"), "utf8");
    assert(moveSource.includes("EphemeralUploadRegistry.purgePrefix"), "moveToDatabase clears the record along with the objects");
    assert(!moveSource.includes("taskFiles.map(filePath => Persistence.delete"), "the open-coded delete loop is gone");

    // The eager purge only clears the registry row when its prefix string is
    // identical to the registered one, and those live in different files. Both
    // must therefore come from the shared builder rather than from their own
    // template literal.
    assert(
        generateSource.includes("GenerationStagingPolicy.buildStoragePrefix") &&
        moveSource.includes("GenerationStagingPolicy.buildStoragePrefix"),
        "registration and eager purge build the prefix from one shared owner, so they cannot drift",
    );
    assert(
        GenerationStagingPolicy.buildStoragePrefix("abc").endsWith("/"),
        "the staging prefix ends in a separator, so a purge cannot reach a run whose id shares a leading substring",
    );
}

// ── Tier 2: real registry against MongoDB ─────────────────────────────────
async function verifyRegistryAgainstDatabase()
{
    heading("DB  The real registry against the ephemeralUploads collection");

    if (process.env.VERIFY_PREFIX_DB !== "1")
    {
        skip("VERIFY_PREFIX_DB is not 1 — database tier not run");
        return;
    }

    let database;
    try
    {
        database = await DatabaseConnector.getDatabase();
    }
    catch (connectionError)
    {
        skip(`MongoDB unreachable (${connectionError?.message || connectionError})`);
        return;
    }

    if (!database)
    {
        skip("MongoDB unreachable — no database handle");
        return;
    }

    const throwawayUserId = "verify-prefix-user.invalid";
    const throwawayPrefix = `${PersistenceConstants.TASKS_DIRECTORY}/verify-prefix-task.invalid/`;
    const collection = database.collection(DatabaseConstants.EPHEMERAL_UPLOADS_COLLECTION);

    try
    {
        const bRegistered = await EphemeralUploadRegistry.register
        ({
            storagePrefix: throwawayPrefix,
            kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
            userId: throwawayUserId,
            retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
            metadata: { mainTaskId: "verify-prefix-task.invalid" },
        });
        assert(bRegistered === true, "the registration writes against the real collection");

        const storedRecord = await collection.findOne({ storagePrefix: throwawayPrefix });
        assert(storedRecord !== null, "the record is readable back");
        assert(storedRecord.kind === ephemeralUploadKinds.GENERATION_TASK_STAGING, "the persisted kind round-trips");
        assert(typeof storedRecord.id === "string" && storedRecord.id.length > 0, "the record carries an id");

        await EphemeralUploadRegistry.register
        ({
            storagePrefix: throwawayPrefix,
            kind: ephemeralUploadKinds.GENERATION_TASK_STAGING,
            userId: throwawayUserId,
            retentionDays: DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS,
        });
        const duplicateCount = await collection.countDocuments({ storagePrefix: throwawayPrefix });
        assert(duplicateCount === 1, "re-registering the same prefix upserts rather than duplicating");

        const farFuture = Date.now() + (DatabaseConstants.GENERATION_STAGING_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
        const dueRecords = await EphemeralUploadRegistry.findDue(farFuture, 500);
        assert(
            dueRecords.some(dueRecord => dueRecord.storagePrefix === throwawayPrefix),
            "the record becomes due once its window has elapsed",
        );

        const purgedCount = await EphemeralUploadRegistry.purgeAllForUser(throwawayUserId);
        assert(purgedCount === 1, "purgeAllForUser reaches a generation-staging record");

        const remaining = await collection.countDocuments({ storagePrefix: throwawayPrefix });
        assert(remaining === 0, "no throwaway record remains");
    }
    finally
    {
        await collection.deleteMany({ userId: throwawayUserId });
    }
}

async function run()
{
    console.log("Object-storage prefix lifecycle — verification");

    await verifyRetentionWindowsAreOrdered();
    await verifyEveryKindIsDistinct();
    await verifyRegistrationRecordsTheWindow();
    await verifyResumeRefreshesRatherThanDuplicates();
    await verifyEagerPurgeClearsTheRecord();
    await verifyFailedPurgeKeepsTheRecordForRetry();
    await verifyExpiredPrefixesBecomeDue();
    await verifyAccountDeletionReachesGenerationStaging();
    await verifyCallSitesAreWired();

    await verifyRegistryAgainstDatabase();

    console.log("");
    console.log(`Passed ${passedCount}, failed ${failedCount}, skipped ${skippedCount}.`);
    process.exit(failedCount === 0 ? 0 : 1);
}

run().catch(runError =>
{
    console.error("Harness failed:", runError);
    process.exit(1);
});
