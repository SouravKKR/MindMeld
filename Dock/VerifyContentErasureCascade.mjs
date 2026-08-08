/**
 * End-to-end verification harness for the content erasure cascade — the removal
 * of an uploaded document, its stored bytes, and everything derived from it.
 *
 * Run from the Dock directory:
 *     node VerifyContentErasureCascade.mjs
 *
 * It covers the two defects this cascade was corrected for:
 *
 *   R-01  Figure images cropped from an uploaded document were written to
 *         figures/<userId>/<perceptualHash>.png and deleted by nothing. The
 *         cascade now reads those paths before the rows go, drops the objects no
 *         surviving row references, and a bounded sweep reclaims the ones that
 *         accumulated while nothing was deleting them.
 *
 *   R-02  The takedown purge derived ONE blob path from the first matching row.
 *         Storage is per-user, so every other holder's copy survived while the
 *         register recorded the content as removed. It now deletes one copy per
 *         row and reports completion only when every copy went.
 *
 * Two tiers, each self-gating so the default run needs no external services:
 *
 *   1. ALWAYS — pure, in-process checks driving the real InformationSourcePurger
 *      and DerivedContentPurger with monkeypatched Persistence / query-engine
 *      static seams. No database, no network, no bucket.
 *
 *   2. DB (opt-in: VERIFY_ERASURE_DB=1) — drives the real DerivedContentQueryEngine
 *      figure-path lookups against the configured MongoDB, using throwaway rows
 *      under a *.invalid user id that are removed afterwards. Skips if the flag
 *      is off or Mongo is unreachable.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const InformationSourcePurger = require("./Globals/Classes/Content/InformationSourcePurger");
const DerivedContentPurger = require("./Globals/Classes/Content/DerivedContentPurger");
const DerivedContentQueryEngine = require("./Globals/Classes/Database/DerivedContentQueryEngine");
const InformationSourceQueryEngine = require("./Globals/Classes/Database/InformationSourceQueryEngine");
const StorageQuotaEnforcer = require("./Globals/Classes/Storage/StorageQuotaEnforcer");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const PersistenceConstants = require("./Globals/Constants/PersistenceConstants");
const Persistence = require("./Globals/Classes/Persistence");
const InformationSource = require("./Globals/Model/InformationSource");

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

/**
 * Captures the real static methods this harness replaces so every scenario
 * starts from the shipped behaviour rather than from the previous scenario's
 * stubs.
 */
const originalImplementations =
{
    persistenceDelete: Persistence.delete,
    persistenceList: Persistence.list,
    persistenceListWithMetadata: Persistence.listWithMetadata,
    deleteInformationSource: InformationSourceQueryEngine.deleteInformationSource,
    getInformationSourcesByHash: InformationSourceQueryEngine.getInformationSourcesByHash,
    purgeForUserAndContentHash: DerivedContentQueryEngine.purgeForUserAndContentHash,
    purgeByContentHash: DerivedContentQueryEngine.purgeByContentHash,
    purgeAllForUser: DerivedContentQueryEngine.purgeAllForUser,
    getFigureStoragePathsForUserAndContentHash: DerivedContentQueryEngine.getFigureStoragePathsForUserAndContentHash,
    getFigureStoragePathsByContentHash: DerivedContentQueryEngine.getFigureStoragePathsByContentHash,
    getFigureStoragePathsForUser: DerivedContentQueryEngine.getFigureStoragePathsForUser,
    getReferencedFigureStoragePaths: DerivedContentQueryEngine.getReferencedFigureStoragePaths,
    invalidate: StorageQuotaEnforcer.invalidate
};

function restoreImplementations()
{
    Persistence.delete = originalImplementations.persistenceDelete;
    Persistence.list = originalImplementations.persistenceList;
    Persistence.listWithMetadata = originalImplementations.persistenceListWithMetadata;
    InformationSourceQueryEngine.deleteInformationSource = originalImplementations.deleteInformationSource;
    InformationSourceQueryEngine.getInformationSourcesByHash = originalImplementations.getInformationSourcesByHash;
    DerivedContentQueryEngine.purgeForUserAndContentHash = originalImplementations.purgeForUserAndContentHash;
    DerivedContentQueryEngine.purgeByContentHash = originalImplementations.purgeByContentHash;
    DerivedContentQueryEngine.purgeAllForUser = originalImplementations.purgeAllForUser;
    DerivedContentQueryEngine.getFigureStoragePathsForUserAndContentHash = originalImplementations.getFigureStoragePathsForUserAndContentHash;
    DerivedContentQueryEngine.getFigureStoragePathsByContentHash = originalImplementations.getFigureStoragePathsByContentHash;
    DerivedContentQueryEngine.getFigureStoragePathsForUser = originalImplementations.getFigureStoragePathsForUser;
    DerivedContentQueryEngine.getReferencedFigureStoragePaths = originalImplementations.getReferencedFigureStoragePaths;
    StorageQuotaEnforcer.invalidate = originalImplementations.invalidate;
}

/**
 * A recording test double for the storage and database seams. `callSequence`
 * exists because the cascade's correctness is an ORDERING property — the figure
 * paths have to be read while the rows still exist — and only the order of calls
 * can demonstrate it.
 */
function buildRecorder(configuration = {})
{
    const recorder =
    {
        callSequence: [],
        deletedPaths: [],
        deletedRowIds: [],
        failingPaths: configuration.failingPaths || [],
        referencedPaths: new Set(configuration.referencedPaths || []),
        figurePathsByUserAndHash: configuration.figurePathsByUserAndHash || {},
        figurePathsByHash: configuration.figurePathsByHash || [],
        figurePathsForUser: configuration.figurePathsForUser || [],
        listedObjects: configuration.listedObjects || [],
        listedPaths: configuration.listedPaths || [],
        failingRowIds: configuration.failingRowIds || []
    };

    Persistence.delete = async (filePath) =>
    {
        recorder.callSequence.push(`delete:${filePath}`);
        if (recorder.failingPaths.includes(filePath))
        {
            throw new Error(`simulated storage failure for ${filePath}`);
        }
        recorder.deletedPaths.push(filePath);
    };

    Persistence.list = async () =>
    {
        recorder.callSequence.push("list");
        return recorder.listedPaths;
    };

    Persistence.listWithMetadata = async (prefix, target, maximumObjectCount, startAfterPath) =>
    {
        recorder.callSequence.push(`listWithMetadata:${prefix}:${maximumObjectCount}:${startAfterPath}`);
        return recorder.listedObjects
            .filter(listedObject => !startAfterPath || listedObject.path > startAfterPath)
            .slice(0, maximumObjectCount);
    };

    InformationSourceQueryEngine.deleteInformationSource = async (informationSource) =>
    {
        recorder.callSequence.push(`deleteRow:${informationSource.getId()}`);
        if (recorder.failingRowIds.includes(informationSource.getId()))
        {
            throw new Error(`simulated row failure for ${informationSource.getId()}`);
        }
        recorder.deletedRowIds.push(informationSource.getId());
    };

    DerivedContentQueryEngine.getFigureStoragePathsForUserAndContentHash = async (userId, contentHash) =>
    {
        recorder.callSequence.push("readFigurePaths");
        return recorder.figurePathsByUserAndHash[`${userId}::${contentHash}`] || [];
    };

    DerivedContentQueryEngine.getFigureStoragePathsByContentHash = async () =>
    {
        recorder.callSequence.push("readFigurePaths");
        return recorder.figurePathsByHash;
    };

    DerivedContentQueryEngine.getFigureStoragePathsForUser = async () =>
    {
        recorder.callSequence.push("readFigurePaths");
        return recorder.figurePathsForUser;
    };

    DerivedContentQueryEngine.getReferencedFigureStoragePaths = async (candidatePaths) =>
    {
        recorder.callSequence.push("referenceCheck");
        return new Set(candidatePaths.filter(candidatePath => recorder.referencedPaths.has(candidatePath)));
    };

    DerivedContentQueryEngine.purgeForUserAndContentHash = async () =>
    {
        recorder.callSequence.push("purgeDerivedRows");
        return { embeddingChunksRemoved: 4, figuresRemoved: 2 };
    };

    DerivedContentQueryEngine.purgeByContentHash = async () =>
    {
        recorder.callSequence.push("purgeDerivedRows");
        return { embeddingChunksRemoved: 7, figuresRemoved: 3 };
    };

    DerivedContentQueryEngine.purgeAllForUser = async () =>
    {
        recorder.callSequence.push("purgeDerivedRows");
        return { embeddingChunksRemoved: 9, figuresRemoved: 5 };
    };

    StorageQuotaEnforcer.invalidate = () => {};

    return recorder;
}

function buildInformationSource({ userId, directoryPath, contentHash })
{
    const informationSource = new InformationSource
    ({
        name: "Textbook.pdf",
        userId: userId,
        sourceType: 1,
        directoryPath: directoryPath,
        hash: contentHash
    });
    return informationSource;
}

const CONTENT_HASH = "a".repeat(128);

// ── Tier 1: takedown completeness (R-02) ──────────────────────────────────
async function verifyTakedownDeletesOneCopyPerHolder()
{
    heading("R-02  Takedown deletes one stored copy per holder");

    const holderUserIds = ["user-one", "user-two", "user-three"];
    const matchingSources = holderUserIds.map(holderUserId => buildInformationSource
    ({
        userId: holderUserId,
        directoryPath: `InformationSources/${holderUserId}`,
        contentHash: CONTENT_HASH
    }));

    const recorder = buildRecorder({ figurePathsByHash: [] });
    InformationSourceQueryEngine.getInformationSourcesByHash = async () => matchingSources;

    const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(CONTENT_HASH);

    assert(purgeResult.rowsRemoved === 3, "every tenant's row is removed");
    assert(purgeResult.storedCopiesFound === 3, "three distinct stored copies are located");
    assert(purgeResult.storedCopiesRemoved === 3, "all three stored copies are deleted");
    assert(purgeResult.bContentRemoved === true, "contentRemoved is true only after every copy went");
    assert(purgeResult.storageError === null, "a complete removal reports no storage error");

    for (const holderUserId of holderUserIds)
    {
        assert(
            recorder.deletedPaths.includes(`InformationSources/${holderUserId}/${CONTENT_HASH}`),
            `${holderUserId}'s own copy was deleted from their own directory`,
        );
    }

    assert(purgeResult.affectedUserIds.length === 3, "all three tenants are recorded as affected");

    restoreImplementations();
}

async function verifyPartialTakedownIsNotReportedComplete()
{
    heading("R-02  A surviving copy is never recorded as removed");

    const matchingSources = ["user-one", "user-two"].map(holderUserId => buildInformationSource
    ({
        userId: holderUserId,
        directoryPath: `InformationSources/${holderUserId}`,
        contentHash: CONTENT_HASH
    }));

    const recorder = buildRecorder({ failingPaths: [`InformationSources/user-two/${CONTENT_HASH}`] });
    InformationSourceQueryEngine.getInformationSourcesByHash = async () => matchingSources;

    const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(CONTENT_HASH);

    assert(purgeResult.storedCopiesFound === 2, "both copies are located");
    assert(purgeResult.storedCopiesRemoved === 1, "only the copy that deleted is counted");
    assert(purgeResult.bContentRemoved === false, "contentRemoved is false when a copy survives");
    assert(typeof purgeResult.storageError === "string" && purgeResult.storageError.includes("user-two"), "the surviving copy is named in the storage error");
    assert(recorder.deletedPaths.includes(`InformationSources/user-one/${CONTENT_HASH}`), "one failure does not abandon the other copies");

    restoreImplementations();
}

async function verifyUnlocatableRowBlocksCompletion()
{
    heading("R-02  A row with no directory path blocks a completion claim");

    const matchingSources =
    [
        buildInformationSource({ userId: "user-one", directoryPath: "InformationSources/user-one", contentHash: CONTENT_HASH }),
        buildInformationSource({ userId: "user-two", directoryPath: null, contentHash: CONTENT_HASH })
    ];

    const recorder = buildRecorder();
    InformationSourceQueryEngine.getInformationSourcesByHash = async () => matchingSources;

    const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(CONTENT_HASH);

    assert(purgeResult.unlocatableRowCount === 1, "the unlocatable row is counted");
    assert(purgeResult.storedCopiesFound === 1, "only the locatable copy is counted as found");
    assert(purgeResult.bContentRemoved === false, "an unlocatable copy blocks contentRemoved");
    assert(!recorder.deletedPaths.includes(CONTENT_HASH), "no bare-hash key is deleted from the bucket root");

    restoreImplementations();
}

async function verifyRowFailureDoesNotStrandOtherTenants()
{
    heading("R-02  One undeletable row does not strand the other tenants");

    const matchingSources = ["user-one", "user-two", "user-three"].map(holderUserId => buildInformationSource
    ({
        userId: holderUserId,
        directoryPath: `InformationSources/${holderUserId}`,
        contentHash: CONTENT_HASH
    }));

    const recorder = buildRecorder({ failingRowIds: [matchingSources[1].getId()] });
    InformationSourceQueryEngine.getInformationSourcesByHash = async () => matchingSources;

    const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(CONTENT_HASH);

    assert(purgeResult.rowsRemoved === 2, "the other two rows are still removed");
    assert(purgeResult.rowsFailed === 1, "the failing row is counted");
    assert(purgeResult.bContentRemoved === false, "a failed row blocks contentRemoved");
    assert(recorder.deletedRowIds.includes(matchingSources[2].getId()), "the loop continues past the failure");

    restoreImplementations();
}

async function verifyDerivedResidueIsPurgedWithoutRows()
{
    heading("R-02  Derived residue is purged even when no row survives");

    const recorder = buildRecorder({ figurePathsByHash: ["figures/user-one/abc.png"] });
    InformationSourceQueryEngine.getInformationSourcesByHash = async () => [];

    const purgeResult = await InformationSourcePurger.purgeAllSourcesWithContentHash(CONTENT_HASH);

    assert(purgeResult.rowsRemoved === 0, "no rows to remove");
    assert(purgeResult.storedCopiesFound === 0, "no stored copy can be located without a row");
    assert(purgeResult.bContentRemoved === false, "an empty removal is not reported as a completed one");
    assert(purgeResult.embeddingChunksRemoved === 7, "embedding chunks are still purged");
    assert(purgeResult.figureObjectsRemoved === 1, "the orphaned figure object is still deleted");
    assert(recorder.deletedPaths.includes("figures/user-one/abc.png"), "the figure object path was reached");

    restoreImplementations();
}

async function verifyStoredCopyCountIsDeduplicated()
{
    heading("R-02  The dry-run copy count deduplicates shared directories");

    const matchingSources =
    [
        buildInformationSource({ userId: "user-one", directoryPath: "InformationSources/user-one", contentHash: CONTENT_HASH }),
        buildInformationSource({ userId: "user-one", directoryPath: "InformationSources/user-one", contentHash: CONTENT_HASH }),
        buildInformationSource({ userId: "user-two", directoryPath: "InformationSources/user-two", contentHash: CONTENT_HASH }),
        buildInformationSource({ userId: "user-three", directoryPath: null, contentHash: CONTENT_HASH })
    ];

    const storedCopyCount = InformationSourcePurger.countStoredCopies(matchingSources, CONTENT_HASH);
    assert(storedCopyCount === 2, "two rows in one directory are one copy, and an unlocatable row is none");
}

// ── Tier 1: extracted-figure erasure (R-01) ───────────────────────────────
async function verifyFigureObjectsAreDeletedWithTheDocument()
{
    heading("R-01  Deleting a document deletes the figure images it produced");

    const informationSource = buildInformationSource
    ({
        userId: "user-one",
        directoryPath: "InformationSources/user-one",
        contentHash: CONTENT_HASH
    });

    const recorder = buildRecorder
    ({
        figurePathsByUserAndHash:
        {
            [`user-one::${CONTENT_HASH}`]: ["figures/user-one/one.png", "figures/user-one/two.png"]
        }
    });

    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    assert(purgeResult.bContentRemoved === true, "the source blob is deleted");
    assert(purgeResult.figureObjectsRemoved === 2, "both figure objects are deleted");
    assert(recorder.deletedPaths.includes("figures/user-one/one.png"), "the first figure object was reached");
    assert(recorder.deletedPaths.includes("figures/user-one/two.png"), "the second figure object was reached");
    assert(purgeResult.storageError === null, "a complete cascade reports no storage error");

    const readIndex = recorder.callSequence.indexOf("readFigurePaths");
    const rowPurgeIndex = recorder.callSequence.indexOf("purgeDerivedRows");
    const referenceIndex = recorder.callSequence.indexOf("referenceCheck");
    assert(readIndex >= 0 && rowPurgeIndex > readIndex, "figure paths are read BEFORE the rows are deleted");
    assert(referenceIndex > rowPurgeIndex, "the last-reference check runs AFTER the rows are deleted");

    restoreImplementations();
}

async function verifyStillReferencedFigureObjectSurvives()
{
    heading("R-01  A figure image another document still shows is kept");

    const informationSource = buildInformationSource
    ({
        userId: "user-one",
        directoryPath: "InformationSources/user-one",
        contentHash: CONTENT_HASH
    });

    const recorder = buildRecorder
    ({
        figurePathsByUserAndHash:
        {
            [`user-one::${CONTENT_HASH}`]: ["figures/user-one/shared.png", "figures/user-one/unique.png"]
        },
        referencedPaths: ["figures/user-one/shared.png"]
    });

    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    assert(purgeResult.figureObjectsRemoved === 1, "only the unreferenced object is deleted");
    assert(recorder.deletedPaths.includes("figures/user-one/unique.png"), "the unreferenced object went");
    assert(!recorder.deletedPaths.includes("figures/user-one/shared.png"), "the object a surviving row points at is kept");

    restoreImplementations();
}

async function verifyBlobFailureStillPurgesDerivedContent()
{
    heading("R-01  A failed blob delete does not skip the derived purge");

    const informationSource = buildInformationSource
    ({
        userId: "user-one",
        directoryPath: "InformationSources/user-one",
        contentHash: CONTENT_HASH
    });

    const recorder = buildRecorder
    ({
        failingPaths: [`InformationSources/user-one/${CONTENT_HASH}`],
        figurePathsByUserAndHash:
        {
            [`user-one::${CONTENT_HASH}`]: ["figures/user-one/one.png"]
        }
    });

    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    assert(purgeResult.bContentRemoved === false, "the failed blob is not reported as removed");
    assert(purgeResult.embeddingChunksRemoved === 4, "the extracted page text is still purged");
    assert(purgeResult.figureObjectsRemoved === 1, "the figure image is still deleted");
    assert(typeof purgeResult.storageError === "string", "the blob failure is reported to the caller");
    assert(recorder.deletedPaths.includes("figures/user-one/one.png"), "the derived cascade ran past the blob failure");

    restoreImplementations();
}

async function verifyFigureObjectFailureIsReported()
{
    heading("R-01  A figure object that will not delete is reported, not hidden");

    const informationSource = buildInformationSource
    ({
        userId: "user-one",
        directoryPath: "InformationSources/user-one",
        contentHash: CONTENT_HASH
    });

    buildRecorder
    ({
        failingPaths: ["figures/user-one/one.png"],
        figurePathsByUserAndHash:
        {
            [`user-one::${CONTENT_HASH}`]: ["figures/user-one/one.png"]
        }
    });

    const purgeResult = await InformationSourcePurger.purgeSingleSource(informationSource);

    assert(purgeResult.figureObjectsRemoved === 0, "nothing is counted as removed");
    assert(typeof purgeResult.storageError === "string" && purgeResult.storageError.includes("figure object"), "the failure names the figure object");
    assert(purgeResult.figuresRemoved === 2, "the rows are still gone, so the reaper's sweep becomes the backstop");

    restoreImplementations();
}

async function verifyOrphanSweepRespectsAgeAndReferences()
{
    heading("R-01  The orphan sweep skips young and still-referenced objects");

    const nowMilliseconds = 1_800_000_000_000;
    const oneDayMilliseconds = 24 * 60 * 60 * 1000;

    const recorder = buildRecorder
    ({
        listedObjects:
        [
            { path: "figures/user-one/old-orphan.png", lastModifiedMilliseconds: nowMilliseconds - (10 * oneDayMilliseconds), sizeBytes: 1 },
            { path: "figures/user-one/old-referenced.png", lastModifiedMilliseconds: nowMilliseconds - (10 * oneDayMilliseconds), sizeBytes: 1 },
            { path: "figures/user-two/just-written.png", lastModifiedMilliseconds: nowMilliseconds - 5_000, sizeBytes: 1 }
        ],
        referencedPaths: ["figures/user-one/old-referenced.png"]
    });

    const sweepResult = await DerivedContentPurger.sweepOrphanedFigureObjects(2000, nowMilliseconds, null);

    assert(sweepResult.inspectedCount === 3, "every listed object is inspected");
    assert(sweepResult.figureObjectsRemoved === 1, "exactly one orphan is reclaimed");
    assert(recorder.deletedPaths.includes("figures/user-one/old-orphan.png"), "the aged, unreferenced object is deleted");
    assert(!recorder.deletedPaths.includes("figures/user-one/old-referenced.png"), "a referenced object is never swept");
    assert(!recorder.deletedPaths.includes("figures/user-two/just-written.png"), "an object written seconds ago is never swept");
    assert(recorder.callSequence.some(call => call.startsWith("listWithMetadata:figures/:2000")), "the sweep is bounded and scoped to the figure prefix");
    assert(sweepResult.nextStartAfterPath === null, "a short page reports the end of the prefix so the next sweep wraps");

    restoreImplementations();
}

async function verifyOrphanSweepAdvancesThroughThePrefix()
{
    heading("R-01  Successive sweeps walk the whole prefix, not just its head");

    const nowMilliseconds = 1_800_000_000_000;
    const oneDayMilliseconds = 24 * 60 * 60 * 1000;
    const agedMilliseconds = nowMilliseconds - (10 * oneDayMilliseconds);

    const recorder = buildRecorder
    ({
        listedObjects:
        [
            { path: "figures/user-a/one.png", lastModifiedMilliseconds: agedMilliseconds, sizeBytes: 1 },
            { path: "figures/user-b/two.png", lastModifiedMilliseconds: agedMilliseconds, sizeBytes: 1 },
            { path: "figures/user-c/three.png", lastModifiedMilliseconds: agedMilliseconds, sizeBytes: 1 }
        ],
        referencedPaths: ["figures/user-a/one.png", "figures/user-b/two.png"]
    });

    const firstSweep = await DerivedContentPurger.sweepOrphanedFigureObjects(2, nowMilliseconds, null);
    assert(firstSweep.inspectedCount === 2, "the first sweep is capped at the inspection limit");
    assert(firstSweep.figureObjectsRemoved === 0, "the head of the prefix is entirely referenced");
    assert(firstSweep.nextStartAfterPath === "figures/user-b/two.png", "a full page reports where to resume");

    const secondSweep = await DerivedContentPurger.sweepOrphanedFigureObjects(2, nowMilliseconds, firstSweep.nextStartAfterPath);
    assert(secondSweep.inspectedCount === 1, "the second sweep resumes past the first page");
    assert(secondSweep.figureObjectsRemoved === 1, "the orphan behind the head is finally reached");
    assert(recorder.deletedPaths.includes("figures/user-c/three.png"), "the deep orphan is deleted");
    assert(secondSweep.nextStartAfterPath === null, "reaching the end resets the cursor");

    restoreImplementations();
}

async function verifyAccountClosureEmptiesTheFigurePrefix()
{
    heading("R-01  Account closure empties the user's whole figure prefix");

    const recorder = buildRecorder
    ({
        figurePathsForUser: ["figures/user-one/recorded.png"],
        listedPaths: ["figures/user-one/recorded.png", "figures/user-one/unrecorded.png"]
    });

    const purgeResult = await DerivedContentPurger.purgeAllForUser("user-one");

    assert(purgeResult.figureObjectsRemoved === 2, "recorded and unrecorded objects are both removed");
    assert(recorder.deletedPaths.includes("figures/user-one/unrecorded.png"), "an object whose row was already lost is still erased");
    assert(purgeResult.embeddingChunksRemoved === 9, "the user's extracted page text is purged");
    assert(purgeResult.figuresRemoved === 5, "the user's figure rows are purged");

    restoreImplementations();
}

async function verifyEmptyUserIdIsRefused()
{
    heading("R-01  purgeAllForUser refuses an empty user id");

    const recorder = buildRecorder({ listedPaths: ["figures/somebody/one.png"] });

    const purgeResult = await DerivedContentPurger.purgeAllForUser("");

    assert(purgeResult.figureObjectsRemoved === 0, "nothing is deleted");
    assert(recorder.deletedPaths.length === 0, "an empty id never becomes a bucket-wide prefix");

    restoreImplementations();
}

// ── Tier 2: real query engine against MongoDB ─────────────────────────────
async function verifyFigurePathLookupsAgainstDatabase()
{
    heading("DB  Figure-path lookups against the real figures collection");

    if (process.env.VERIFY_ERASURE_DB !== "1")
    {
        skip("VERIFY_ERASURE_DB is not 1 — database tier not run");
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

    const throwawayUserId = "verify-erasure-user.invalid";
    const throwawayContentHash = "b".repeat(128);
    const figuresCollection = database.collection(DatabaseConstants.FIGURES_COLLECTION);

    try
    {
        await figuresCollection.insertMany
        ([
            {
                userId: throwawayUserId,
                informationSourceHash: throwawayContentHash,
                perceptualImageHash: "hash-one",
                gcsPath: `${PersistenceConstants.FIGURE_DIRECTORY}/${throwawayUserId}/hash-one.png`
            },
            {
                userId: throwawayUserId,
                informationSourceHash: throwawayContentHash,
                perceptualImageHash: "hash-two",
                gcsPath: `${PersistenceConstants.FIGURE_DIRECTORY}/${throwawayUserId}/hash-two.png`
            }
        ]);

        const storagePaths = await DerivedContentQueryEngine.getFigureStoragePathsForUserAndContentHash(throwawayUserId, throwawayContentHash);
        assert(storagePaths.length === 2, "both figure storage paths are read from the rows");
        assert(storagePaths.every(storagePath => storagePath.startsWith(`${PersistenceConstants.FIGURE_DIRECTORY}/`)), "paths carry the shared figure prefix");

        const referencedPaths = await DerivedContentQueryEngine.getReferencedFigureStoragePaths(
            [...storagePaths, `${PersistenceConstants.FIGURE_DIRECTORY}/${throwawayUserId}/absent.png`],
        );
        assert(referencedPaths.size === 2, "only paths a row points at are reported as referenced");
        assert(!referencedPaths.has(`${PersistenceConstants.FIGURE_DIRECTORY}/${throwawayUserId}/absent.png`), "an unrecorded path is reported as unreferenced");

        const userPaths = await DerivedContentQueryEngine.getFigureStoragePathsForUser(throwawayUserId);
        assert(userPaths.length === 2, "the per-user lookup finds the same paths");

        const purgeCounts = await DerivedContentQueryEngine.purgeAllForUser(throwawayUserId);
        assert(purgeCounts.figuresRemoved === 2, "the per-user row purge removes both rows");

        const remainingCount = await figuresCollection.countDocuments({ userId: throwawayUserId });
        assert(remainingCount === 0, "no throwaway rows remain");
    }
    finally
    {
        await figuresCollection.deleteMany({ userId: throwawayUserId });
    }
}

async function run()
{
    console.log("Content erasure cascade — verification");

    await verifyTakedownDeletesOneCopyPerHolder();
    await verifyPartialTakedownIsNotReportedComplete();
    await verifyUnlocatableRowBlocksCompletion();
    await verifyRowFailureDoesNotStrandOtherTenants();
    await verifyDerivedResidueIsPurgedWithoutRows();
    await verifyStoredCopyCountIsDeduplicated();

    await verifyFigureObjectsAreDeletedWithTheDocument();
    await verifyStillReferencedFigureObjectSurvives();
    await verifyBlobFailureStillPurgesDerivedContent();
    await verifyFigureObjectFailureIsReported();
    await verifyOrphanSweepRespectsAgeAndReferences();
    await verifyOrphanSweepAdvancesThroughThePrefix();
    await verifyAccountClosureEmptiesTheFigurePrefix();
    await verifyEmptyUserIdIsRefused();

    await verifyFigurePathLookupsAgainstDatabase();

    console.log("");
    console.log(`Passed ${passedCount}, failed ${failedCount}, skipped ${skippedCount}.`);
    process.exit(failedCount === 0 ? 0 : 1);
}

run().catch(runError =>
{
    console.error("Harness failed:", runError);
    process.exit(1);
});
