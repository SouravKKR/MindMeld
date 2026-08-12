/**
 * VerifyPaidDeckVerificationSources — harness for admin-declared verification
 * sources on paid decks.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckVerificationSources.mjs
 *     VERIFY_PAID_DECK_VERIFICATION_SOURCES_DB=1 node VerifyPaidDeckVerificationSources.mjs
 *
 * Tier 1 is pure and always runs. Tiers touching Mongo are opt-in behind the env
 * flag, the same shape as VerifyContentRefinement and VerifyPaidDeckPublishGate.
 *
 * What it protects, in the order the failures would hurt:
 *
 *   AN UNVERIFIED RUN LOOKING VERIFIED. Source flags are APPENDED to
 *   verification.flags, because every downstream reader addresses a flag by its
 *   index into that array. A $push into a record with no verification object
 *   would CREATE one, handing PaidDeckPublishGate a fabricated verification for
 *   a run that was never verified — the precise failure the gate exists to
 *   prevent. The filter that stops this is checked directly.
 *
 *   A DUPLICATED BLOCKING FLAG. The pass runs as a background task and can be
 *   started twice — a Dock restart loses the in-process marker, or an
 *   administrator clicks twice. A second append would duplicate every flag, and
 *   a duplicated blocking flag must be resolved twice to stop blocking, which
 *   reads as the gate being broken. Idempotency on passId is checked from both
 *   directions: the same pass twice appends once, a different pass still
 *   appends.
 *
 *   A SHIFTED FLAG INDEX. Resolutions, auto-fixes and the publish gate all
 *   address flags positionally. If an append could move an existing index, a
 *   recorded decision would silently come to refer to a different flag.
 *
 *   A DECLARATION WITHOUT A BASIS. The licence gate is the only thing stopping a
 *   source being recorded with licenceType 0 — the refinement path's equivalent
 *   check lives only in the browser, and this one must not. Every enum value is
 *   driven through it.
 *
 *   DESTROYED EVIDENCE. A declared source has to outlive the retention rules, or
 *   the declaration describes a document nobody can produce. The hold is checked
 *   in both directions: a declared source survives, an undeclared one is still
 *   reaped.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const VerificationSourceLicenceGate = require("./Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
const SourceUsageGate = require("./Globals/Classes/PaidDeck/SourceUsageGate");
const PaidDeckPublishGate = require("./Globals/Classes/Generation/PaidDeckPublishGate");
const GenerationProvenanceQueryEngine = require("./Globals/Classes/Database/GenerationProvenanceQueryEngine");
const PaidDeckVerificationSourceQueryEngine = require("./Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("./Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const ReferencedProofSourceHashes = require("./Globals/Classes/Content/ReferencedProofSourceHashes");
const SourceRetentionPolicy = require("./Globals/Classes/Content/SourceRetentionPolicy");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const InformationSource = require("./Globals/Model/InformationSource");
const { sourceLicenceTypes } = require("./Globals/Enumerations/SourceLicenceTypes");
const { sourceUsageModes } = require("./Globals/Enumerations/SourceUsageModes");

const TEST_PREFIX = "verify-verification-sources-";

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

// ── Tier 1: the licence gate ───────────────────────────────────────────────

function runLicenceGateTier()
{
    section("Every licence value is decided, and \"not specified\" is never a declaration");

    // Driven off the enum rather than a hand-written list, so a value added to
    // SourceLicenceTypes without a rule here fails loudly instead of falling
    // through to whatever the last branch happens to do.
    const expectedOutcomesByLicenceType =
    {
        [sourceLicenceTypes.UNSPECIFIED]: { bare: false, withNote: false, withUrl: false },
        [sourceLicenceTypes.CC0]: { bare: true, withNote: true, withUrl: true },
        [sourceLicenceTypes.PUBLIC_DOMAIN]: { bare: true, withNote: true, withUrl: true },
        [sourceLicenceTypes.OWN_WORK]: { bare: true, withNote: true, withUrl: true },
        [sourceLicenceTypes.CC_BY]: { bare: false, withNote: true, withUrl: true },
        [sourceLicenceTypes.LICENSED_PERMISSION]: { bare: false, withNote: true, withUrl: false },
        [sourceLicenceTypes.OTHER]: { bare: false, withNote: true, withUrl: false },
    };

    for (const [licenceName, licenceType] of Object.entries(sourceLicenceTypes))
    {
        const expected = expectedOutcomesByLicenceType[licenceType];

        if (expected === undefined)
        {
            assert(false, `${licenceName} has an expected outcome in this harness — a new licence value needs a rule`);
            continue;
        }

        assert(
            VerificationSourceLicenceGate.evaluate({ licenceType: licenceType }).allowed === expected.bare,
            `${licenceName} with nothing else is ${expected.bare ? "accepted" : "refused"}`,
        );

        assert(
            VerificationSourceLicenceGate.evaluate({ licenceType: licenceType, licenceNote: "Stated basis" }).allowed === expected.withNote,
            `${licenceName} with a note is ${expected.withNote ? "accepted" : "refused"}`,
        );

        assert(
            VerificationSourceLicenceGate.evaluate({ licenceType: licenceType, sourceUrl: "https://example.org/source" }).allowed === expected.withUrl,
            `${licenceName} with only a URL is ${expected.withUrl ? "accepted" : "refused"}`,
        );
    }

    section("A refusal says which rule refused it");

    assert(
        VerificationSourceLicenceGate.evaluate({ licenceType: sourceLicenceTypes.CC_BY }).errorCode
            === ErrorCodes.VERIFICATION_SOURCE_ATTRIBUTION_REQUIRED,
        "CC BY with no attribution reports the attribution rule, not a generic error",
    );

    assert(
        VerificationSourceLicenceGate.evaluate({ licenceType: sourceLicenceTypes.OTHER }).errorCode
            === ErrorCodes.VERIFICATION_SOURCE_LICENCE_REQUIRED,
        "Other with no note reports the licence rule",
    );

    assert(
        VerificationSourceLicenceGate.evaluate({}).allowed === false,
        "A declaration with no licence field at all is refused rather than defaulted",
    );

    assert(
        VerificationSourceLicenceGate.evaluate({ licenceType: 9999 }).allowed === false,
        "A value outside the enum is refused rather than treated as the first one",
    );

    assert(
        VerificationSourceLicenceGate.evaluate({ licenceType: sourceLicenceTypes.OTHER, licenceNote: "   " }).allowed === false,
        "Whitespace is not a note",
    );
}

// ── Tier 1: flag addressing ────────────────────────────────────────────────

function runFlagAddressingTier()
{
    section("Appending flags cannot move an index a decision already refers to");

    // The property the whole append design rests on, asserted on plain arrays:
    // every reader addresses a flag by index, so an append must only ever add
    // positions at the end.
    const existingFlags = [
        { category: "CONSTANT", severity: "blocking", source: "REFERENCE_SET" },
        { category: "UNITS", severity: "advisory", source: "MODEL" },
    ];

    const resolvedFlagIndex = 0;
    const flagBeforeAppend = existingFlags[resolvedFlagIndex];

    const appendedFlags = [...existingFlags, { category: "DEFINITION", severity: "blocking", source: "ADMIN_SOURCE" }];

    assert(appendedFlags[resolvedFlagIndex] === flagBeforeAppend, "Index 0 still names the same flag after an append");
    assert(appendedFlags.length === existingFlags.length + 1, "The appended flag lands at the end");
    assert(appendedFlags[2].source === "ADMIN_SOURCE", "The source-grounded flag is distinguishable from a model's own opinion");

    section("The publish gate treats a source-grounded blocking flag like any other");

    const provenanceRecord =
    {
        mainTaskId: "run-1",
        verification: { flags: appendedFlags },
        flagResolutions: [{ flagIndex: 0, resolution: PaidDeckPublishGate.RESOLUTION_FIXED }],
    };

    const unresolvedBlockingIndices = provenanceRecord.verification.flags
        .map((flag, flagIndex) => ({ flag, flagIndex }))
        .filter(entry => entry.flag.severity === "blocking")
        .filter(entry => !provenanceRecord.flagResolutions.some(resolution => resolution.flagIndex === entry.flagIndex))
        .map(entry => entry.flagIndex);

    assert(
        unresolvedBlockingIndices.length === 1 && unresolvedBlockingIndices[0] === 2,
        "The resolved reference-set flag clears; the new source-grounded one still blocks",
    );

    assert(
        PaidDeckPublishGate.isClearingResolution(PaidDeckPublishGate.RESOLUTION_FIXED)
            && PaidDeckPublishGate.isClearingResolution(PaidDeckPublishGate.RESOLUTION_NOT_A_PROBLEM),
        "Both recorded decisions clear a flag — a source flag is answered the same way as any other",
    );
}

// ── Tier 1: retention ──────────────────────────────────────────────────────

function runRetentionHoldTier()
{
    section("A declared source outlives the retention rules; an undeclared one does not");

    const declaredSource = new InformationSource
    ({
        name: "textbook.pdf",
        userId: "user-1",
        sourceType: 0,
        directoryPath: "/InformationSources/user-1",
        hash: "declared-hash",
        uploadedAt: 1000,
        retentionMode: 1,
        licenceType: sourceLicenceTypes.CC0,
    });

    const undeclaredSource = new InformationSource
    ({
        name: "scratch.pdf",
        userId: "user-1",
        sourceType: 0,
        directoryPath: "/InformationSources/user-1",
        hash: "undeclared-hash",
        uploadedAt: 1000,
        retentionMode: 1,
    });

    const heldHashes = new Set(["declared-hash"]);
    const lapsedPolicy = { bRetained: false, deleteBeforeMilliseconds: null };

    assert(
        SourceRetentionPolicy.isSourceUnderLegalHold(declaredSource, heldHashes),
        "A source whose hash a declaration cites is held",
    );

    assert(
        !SourceRetentionPolicy.isSourceUnderLegalHold(undeclaredSource, heldHashes),
        "An uncited source is not held — the hold must not over-block",
    );

    assert(
        SourceRetentionPolicy.isSourceDue(declaredSource, lapsedPolicy, 999999, heldHashes) === false,
        "A declared source survives a lapsed subscription",
    );

    assert(
        SourceRetentionPolicy.isSourceDue(undeclaredSource, lapsedPolicy, 999999, heldHashes) === true,
        "An undeclared source is still reaped — the retention promise still holds",
    );

    assert(
        !SourceRetentionPolicy.isSourceUnderLegalHold(declaredSource, null),
        "A caller that skipped the lookup does not silently hold everything",
    );
}

// ── Tier 1: the working set vs the log ─────────────────────────────────────

function runCollectionContractTier()
{
    section("The log is insert-only; the working set is the only mutable half");

    assert(
        typeof SourceLicenceDeclarationQueryEngine.record === "function"
            && typeof SourceLicenceDeclarationQueryEngine.update === "undefined"
            && typeof SourceLicenceDeclarationQueryEngine.delete === "undefined",
        "SourceLicenceDeclarationQueryEngine exposes no update or delete — an editable log evidences nothing",
    );

    assert(
        typeof PaidDeckVerificationSourceQueryEngine.detach === "function",
        "The working set can be detached from — the deck's current sources have to be changeable",
    );

    assert(
        SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED === "ATTACHED"
            && SourceLicenceDeclarationQueryEngine.EVENT_DETACHED === "DETACHED",
        "Both acts are recordable — a removal that left no trace would erase the basis for a past check",
    );

    assert(
        Number.isInteger(PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK)
            && PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK > 0,
        "There is a bound on how many sources one deck may have attached",
    );
}

// ── Database tier ──────────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("Database tier (opt-in: VERIFY_PAID_DECK_VERIFICATION_SOURCES_DB=1)");

    if (process.env.VERIFY_PAID_DECK_VERIFICATION_SOURCES_DB !== "1")
    {
        skip("append is idempotent on passId");
        skip("append is refused on a run with no verification result");
        skip("attach then detach leaves two declarations and no active source");
        skip("the hold union finds a declared hash");
        return;
    }

    const database = await DatabaseConnector.getDatabase();

    if (!database)
    {
        skip("database unreachable — the whole tier");
        return;
    }

    const provenanceCollection = database.collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);
    const sourcesCollection = database.collection(DatabaseConstants.PAID_DECK_VERIFICATION_SOURCES_COLLECTION);
    const declarationsCollection = database.collection(DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION);

    const verifiedRunId = `${TEST_PREFIX}run-verified`;
    const unverifiedRunId = `${TEST_PREFIX}run-unverified`;
    const testDeckId = `${TEST_PREFIX}deck`;
    const testUserId = `${TEST_PREFIX}user`;

    try
    {
        await provenanceCollection.insertOne({
            id: `${TEST_PREFIX}p1`,
            mainTaskId: verifiedRunId,
            deckId: testDeckId,
            verification: { flags: [{ category: "CONSTANT", severity: "blocking", source: "REFERENCE_SET" }], blockingFlagCount: 1, advisoryFlagCount: 0 },
            flagResolutions: [],
            recordedAt: Date.now(),
        });

        // A run the standard verification never wrote a result for. This is the
        // state the append must refuse rather than repair.
        await provenanceCollection.insertOne({
            id: `${TEST_PREFIX}p2`,
            mainTaskId: unverifiedRunId,
            deckId: testDeckId,
            verification: null,
            flagResolutions: [],
            recordedAt: Date.now(),
        });

        const sourceFlags = [
            { category: "DEFINITION", severity: "blocking", source: "ADMIN_SOURCE", citedPassage: "The source says otherwise." },
            { category: "UNITS", severity: "advisory", source: "ADMIN_SOURCE", citedPassage: "Given in kilojoules." },
        ];

        const firstAppend = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(verifiedRunId, "pass-1", sourceFlags);
        assert(firstAppend.appended === true, "A pass's flags append to the run that was verified");

        const secondAppend = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(verifiedRunId, "pass-1", sourceFlags);
        assert(
            secondAppend.appended === false && secondAppend.reason === "PASS_ALREADY_APPENDED",
            "Re-running the SAME pass appends nothing — a duplicated blocking flag would have to be resolved twice",
        );

        const afterAppend = await provenanceCollection.findOne({ mainTaskId: verifiedRunId });

        assert(afterAppend.verification.flags.length === 3, "Exactly one copy of each flag landed");
        assert(afterAppend.verification.flags[0].source === "REFERENCE_SET", "The pre-existing flag kept index 0");
        assert(afterAppend.verification.blockingFlagCount === 2, "The blocking count grew by the blocking flags only");
        assert(afterAppend.verification.advisoryFlagCount === 1, "The advisory count grew by the advisory flags only");

        const differentPassAppend = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(
            verifiedRunId, "pass-2", [{ category: "FORMULA", severity: "advisory", source: "ADMIN_SOURCE" }]);
        assert(differentPassAppend.appended === true, "A genuinely new pass still appends");

        const refusedAppend = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(
            unverifiedRunId, "pass-3", sourceFlags);
        assert(
            refusedAppend.appended === false && refusedAppend.reason === "RUN_NOT_VERIFIED",
            "A run with no verification result is REFUSED — creating one would hand the publish gate a fabricated pass",
        );

        const stillUnverified = await provenanceCollection.findOne({ mainTaskId: unverifiedRunId });
        assert(
            stillUnverified.verification === null,
            "The refused append wrote nothing — the run still reads as unverified, which it is",
        );

        const missingAppend = await GenerationProvenanceQueryEngine.appendSourceVerificationFlags(
            `${TEST_PREFIX}no-such-run`, "pass-4", sourceFlags);
        assert(missingAppend.reason === "RECORD_NOT_FOUND", "A missing record is reported as missing, not as already-appended");

        section("Attach, detach, and what survives (database)");

        const verificationSource =
        {
            id: `${TEST_PREFIX}source-1`,
            deckId: testDeckId,
            informationSourceId: `${TEST_PREFIX}info-1`,
            name: "Reference textbook",
            sourceUrl: "",
            contentHash: `${TEST_PREFIX}hash`,
            storagePath: `/InformationSources/${testUserId}/${TEST_PREFIX}hash`,
            mimeType: "application/pdf",
            licenceType: sourceLicenceTypes.CC0,
            licenceNote: "",
            declaredByUserId: testUserId,
            attachedAt: Date.now(),
            detachedAt: 0,
            active: true,
        };

        await SourceLicenceDeclarationQueryEngine.record({
            event: SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,
            deckId: testDeckId,
            verificationSourceId: verificationSource.id,
            informationSourceId: verificationSource.informationSourceId,
            sourceName: verificationSource.name,
            sourceHash: verificationSource.contentHash,
            licenceType: verificationSource.licenceType,
            declaredByUserId: testUserId,
            declaredByEmail: "admin@example.test",
        });

        await PaidDeckVerificationSourceQueryEngine.attach(verificationSource);

        const activeSources = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(testDeckId);
        assert(activeSources.length === 1, "The attached source is what a check would use");

        assert(
            await PaidDeckVerificationSourceQueryEngine.isAlreadyAttached(testDeckId, verificationSource.contentHash, ""),
            "The same document is recognised as already attached — attaching twice would double its weight",
        );

        const heldHashes = await ReferencedProofSourceHashes.findForUser(testUserId);
        assert(
            heldHashes.has(verificationSource.contentHash),
            "The hold union finds a hash declared as a verification source, not only refinement hashes",
        );

        section("A content-only source is attached and held, but never checked against (database)");

        // The row above deliberately carries NO usageMode at all — it is the
        // legacy shape, and everything asserted about it so far is what a row
        // written before the field existed must still do.
        assert(
            verificationSource.usageMode === undefined
            && SourceUsageGate.isVerificationUsage(activeSources[0].usageMode) === true
            && SourceUsageGate.isContentUsage(activeSources[0].usageMode) === false,
            "A stored row with no usageMode field is still checked against, and still not written from",
        );

        const contentOnlySource =
        {
            ...verificationSource,
            id: `${TEST_PREFIX}source-2`,
            informationSourceId: `${TEST_PREFIX}info-2`,
            name: "Licensed question paper",
            contentHash: `${TEST_PREFIX}hash-2`,
            storagePath: `/InformationSources/${testUserId}/${TEST_PREFIX}hash-2`,
            licenceType: sourceLicenceTypes.LICENSED_PERMISSION,
            licenceNote: "Purchased under order #1234.",
            usageMode: sourceUsageModes.CONTENT_ONLY,
        };

        await SourceLicenceDeclarationQueryEngine.record({
            event: SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,
            deckId: testDeckId,
            verificationSourceId: contentOnlySource.id,
            informationSourceId: contentOnlySource.informationSourceId,
            sourceName: contentOnlySource.name,
            sourceHash: contentOnlySource.contentHash,
            licenceType: contentOnlySource.licenceType,
            usageMode: contentOnlySource.usageMode,
            declaredByUserId: testUserId,
            declaredByEmail: "admin@example.test",
        });

        await PaidDeckVerificationSourceQueryEngine.attach(contentOnlySource);

        const bothAttached = await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(testDeckId);

        assert(
            bothAttached.length === 2,
            "The content-only source IS attached — the list a reviewer sees shows every mode, and the row "
            + "is what records the licence the deck was written under",
        );

        assert(
            SourceUsageGate.selectVerificationSources(bothAttached).length === 1,
            "...and is NOT among the sources a check would read — attached and checked-against are now "
            + "different sets, and this is the row that separates them",
        );

        const heldWithContentOnly = await ReferencedProofSourceHashes.findForUser(testUserId);
        assert(
            heldWithContentOnly.has(contentOnlySource.contentHash),
            "Its document is held against deletion like any other — it is the proof behind text that was "
            + "actually written from it, which makes it the last file that may ever be swept",
        );

        await PaidDeckVerificationSourceQueryEngine.detach(contentOnlySource.id, Date.now());

        const bDetached = await PaidDeckVerificationSourceQueryEngine.detach(verificationSource.id, Date.now());
        assert(bDetached === true, "Detaching removes it from the working set");

        await SourceLicenceDeclarationQueryEngine.record({
            event: SourceLicenceDeclarationQueryEngine.EVENT_DETACHED,
            deckId: testDeckId,
            verificationSourceId: verificationSource.id,
            sourceName: verificationSource.name,
            sourceHash: verificationSource.contentHash,
            licenceType: verificationSource.licenceType,
            declaredByUserId: testUserId,
        });

        assert(
            (await PaidDeckVerificationSourceQueryEngine.findActiveByDeckId(testDeckId)).length === 0,
            "A detached source is no longer checked against",
        );

        const declarations = await SourceLicenceDeclarationQueryEngine.findAllByDeckId(testDeckId);
        assert(
            declarations.length === 3,
            "Every act is in the log — two attachments and a removal, and the removal erased neither attachment",
        );
        assert(
            declarations.map(declaration => declaration.event).join(",") === "ATTACHED,ATTACHED,DETACHED",
            "The log reads in the order it happened",
        );

        assert(
            declarations.some(declaration => declaration.usageMode === sourceUsageModes.CONTENT_ONLY),
            "The permanent log records the mode the source was declared under, so what the deck was written "
            + "from stays answerable after the source is detached",
        );

        const heldAfterDetach = await ReferencedProofSourceHashes.findForUser(testUserId);
        assert(
            heldAfterDetach.has(verificationSource.contentHash),
            "The document is STILL held after detaching — a past check must stay checkable against it",
        );
    }
    finally
    {
        await provenanceCollection.deleteMany({ mainTaskId: { $regex: `^${TEST_PREFIX}` } });
        await sourcesCollection.deleteMany({ deckId: testDeckId });
        await declarationsCollection.deleteMany({ deckId: testDeckId });
    }
}

async function main()
{
    console.log("Verifying paid-deck verification sources...\n");

    runLicenceGateTier();
    runFlagAddressingTier();
    runRetentionHoldTier();
    runCollectionContractTier();
    await runDatabaseTier();

    console.log(`\nPassed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
