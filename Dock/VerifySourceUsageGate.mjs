/**
 * VerifySourceUsageGate — harness for the per-source decision about what a
 * declared document may be used for: writing a paid deck's content, checking the
 * finished deck against it, or both.
 *
 * Run from the Dock directory:
 *     node VerifySourceUsageGate.mjs
 *     VERIFY_SOURCE_USAGE_DB=1 node VerifySourceUsageGate.mjs
 *
 * Tier 1 is pure and always runs. The Mongo tier is opt-in behind the env flag,
 * the same shape as VerifyPaidDeckVerificationSources.
 *
 * What it protects, in the order the failures would hurt:
 *
 *   SELLING CONTENT WRITTEN FROM A DOCUMENT NOBODY MAY DERIVE FROM. This is the
 *   whole reason the gate exists. A complete licence declaration is not the same
 *   as a right to create new material: "Other — described in the note" is a
 *   complete declaration and is fine for checking a deck against, but nothing in
 *   it commits to the derivative right. Every licence value is driven through
 *   every usage mode so a value added later cannot fall through to whatever the
 *   last branch happened to do.
 *
 *   A SOURCE READ BY THE WRONG STAGE. "Attached" and "checked against" stopped
 *   being the same set once a source could be marked write-only, so the two
 *   questions are asked separately and their defaults point in opposite
 *   directions: an unreadable mode is NOT content but IS verification. Both
 *   directions are asserted, because getting either backwards is silent — one
 *   writes sellable text from a document nobody cleared, the other quietly stops
 *   checking older decks at all.
 *
 *   A GATE THAT DEPENDS ON ANOTHER GATE HAVING RUN. SourceUsageGate is reached
 *   after VerificationSourceLicenceGate on every current path, but a gate whose
 *   correctness rests on call order is not a gate. It is checked in isolation,
 *   including that it refuses UNSPECIFIED on its own account.
 *
 *   A SILENT PROMOTION. usageMode arrives from a client. Anything unrecognised
 *   must normalise to verification-only, never to content — a malformed field
 *   may only ever narrow what a source is used for.
 *
 *   A REWRITTEN HISTORY. The declaration log is the evidence. An edit to a
 *   source's note or usage must APPEND an event rather than overwrite one, and
 *   the event must be labelled as what it actually was: the record() coercion
 *   used to relabel anything it did not recognise as ATTACHED, which would have
 *   put a false act in the one collection whose entire value is being true.
 *
 *   LOST BYTES. A document declared as a content source is the proof behind
 *   every card written from it. Editing its note must not release the retention
 *   hold on it.
 */

import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const SourceUsageGate = require("./Globals/Classes/PaidDeck/SourceUsageGate");
const VerificationSourceLicenceGate = require("./Globals/Classes/PaidDeck/VerificationSourceLicenceGate");
const VerificationSourceAdmission = require("./Endpoints/AutomaticGeneration/Helpers/VerificationSourceAdmission");
const PaidDeckVerificationSourceQueryEngine = require("./Globals/Classes/Database/PaidDeckVerificationSourceQueryEngine");
const SourceLicenceDeclarationQueryEngine = require("./Globals/Classes/Database/SourceLicenceDeclarationQueryEngine");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");
const { sourceLicenceTypes } = require("./Globals/Enumerations/SourceLicenceTypes");
const { sourceUsageModes } = require("./Globals/Enumerations/SourceUsageModes");

const TEST_PREFIX = "verify-source-usage-";

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


// ── Tier 1: the gate itself ────────────────────────────────────────────────

function runUsageGateTier()
{
    section("Every licence is decided for every usage mode");

    // Driven off the enum rather than a hand-written list, so a value added to
    // SourceLicenceTypes without a rule here fails loudly.
    const contentAllowedByLicenceType =
    {
        [sourceLicenceTypes.UNSPECIFIED]: false,
        [sourceLicenceTypes.CC0]: true,
        [sourceLicenceTypes.PUBLIC_DOMAIN]: true,
        [sourceLicenceTypes.CC_BY]: true,
        [sourceLicenceTypes.OWN_WORK]: true,
        [sourceLicenceTypes.LICENSED_PERMISSION]: true,
        [sourceLicenceTypes.OTHER]: false,
    };

    for (const [licenceName, licenceType] of Object.entries(sourceLicenceTypes))
    {
        const expectedContentAllowed = contentAllowedByLicenceType[licenceType];

        if (expectedContentAllowed === undefined)
        {
            assert(false, `${licenceName} has a rule in this harness — a new licence value needs one`);
            continue;
        }

        // Verification-only is what every source could already do under any
        // complete declaration. This gate must never narrow that.
        assert(
            SourceUsageGate.evaluate({ licenceType: licenceType, usageMode: sourceUsageModes.VERIFICATION_ONLY }).allowed === true,
            `${licenceName} may be used for checking`,
        );

        // Driven off the gate's own set rather than a list written here, so a
        // content-bearing mode added later is licence-checked by this harness
        // the moment it exists. The modes are held to ONE rule on purpose:
        // declining to check the deck against a document afterwards does not
        // lessen the right engaged by writing the deck from it.
        for (const contentUsageMode of SourceUsageGate.CONTENT_BEARING_USAGE_MODES)
        {
            const modeName = Object.keys(sourceUsageModes)
                .find(candidateName => sourceUsageModes[candidateName] === contentUsageMode);

            const contentDecision = SourceUsageGate.evaluate({
                licenceType: licenceType,
                usageMode: contentUsageMode,
            });

            assert(
                contentDecision.allowed === expectedContentAllowed,
                `${licenceName} ${expectedContentAllowed ? "MAY" : "may NOT"} be used for ${modeName}`,
            );

            if (!expectedContentAllowed)
            {
                assert(
                    contentDecision.errorCode === ErrorCodes.SOURCE_USAGE_NOT_PERMITTED_BY_LICENCE,
                    `${licenceName} is refused for ${modeName} with the code the dialog branches on`,
                );

                assert(
                    typeof contentDecision.detail === "string" && contentDecision.detail.length > 0,
                    `${licenceName} is refused for ${modeName} with a reason a person can act on, not just a code`,
                );
            }
        }
    }

    section("Every usage mode is covered by exactly one of the two questions, and content is the narrow one");

    // The invariant that stops a mode added later from silently vanishing from
    // both pipelines, or from quietly joining the one that writes sellable text.
    for (const [modeName, usageMode] of Object.entries(sourceUsageModes))
    {
        assert(
            SourceUsageGate.isContentUsage(usageMode) || SourceUsageGate.isVerificationUsage(usageMode),
            `${modeName} is read by at least one stage — a mode read by neither is a source that does nothing`,
        );

        if (SourceUsageGate.isContentUsage(usageMode))
        {
            assert(
                SourceUsageGate.evaluate({ licenceType: sourceLicenceTypes.OTHER, usageMode: usageMode }).allowed === false,
                `${modeName} writes content and is therefore refused under "Other"`,
            );

            assert(
                SourceUsageGate.evaluate({ licenceType: sourceLicenceTypes.UNSPECIFIED, usageMode: usageMode }).allowed === false,
                `${modeName} writes content and is therefore refused under UNSPECIFIED`,
            );
        }
    }

    section("The gate stands alone, and fails closed");

    // "Other with a note" is a COMPLETE declaration — the licence gate accepts
    // it — and still may not write content. That divergence is the entire
    // reason this is a second gate rather than a branch inside the first.
    const otherWithNote = { licenceType: sourceLicenceTypes.OTHER, licenceNote: "Permission discussed by email" };

    assert(
        VerificationSourceLicenceGate.evaluate(otherWithNote).allowed === true,
        "\"Other\" with a note passes the LICENCE gate — the declaration is complete",
    );

    assert(
        SourceUsageGate.evaluate({ licenceType: sourceLicenceTypes.OTHER, usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION }).allowed === false,
        "...and is still refused for CONTENT — a complete declaration is not a derivative right",
    );

    assert(
        SourceUsageGate.evaluate({ licenceType: sourceLicenceTypes.UNSPECIFIED, usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION }).allowed === false,
        "UNSPECIFIED is refused here too, not only by the licence gate — a gate that relies on another "
        + "gate having run is not a gate",
    );

    const malformedCases = [
        ["no usage mode at all", { licenceType: sourceLicenceTypes.CC0 }],
        ["an unrecognised usage mode", { licenceType: sourceLicenceTypes.CC0, usageMode: 99 }],
        ["a usage mode that is not a number", { licenceType: sourceLicenceTypes.CC0, usageMode: "CONTENT" }],
        ["nothing at all", null],
    ];

    for (const [label, declaration] of malformedCases)
    {
        const decision = SourceUsageGate.evaluate(declaration);

        assert(
            decision.allowed === false && decision.errorCode === ErrorCodes.SOURCE_USAGE_MODE_INVALID,
            `${label} is refused rather than assumed`,
        );
    }

    section("An unreadable usage mode can only ever narrow what a source is used for");

    const nameOfUsageMode = (usageMode) => Object.keys(sourceUsageModes)
        .find(candidateName => sourceUsageModes[candidateName] === usageMode) || String(usageMode);

    const normalisationCases = [
        [undefined, sourceUsageModes.VERIFICATION_ONLY],
        [null, sourceUsageModes.VERIFICATION_ONLY],
        ["CONTENT_AND_VERIFICATION", sourceUsageModes.VERIFICATION_ONLY],
        [99, sourceUsageModes.VERIFICATION_ONLY],
        [-1, sourceUsageModes.VERIFICATION_ONLY],
        [1.5, sourceUsageModes.VERIFICATION_ONLY],
        [{}, sourceUsageModes.VERIFICATION_ONLY],

        // Number(true) is 1, and 1 is a content mode. Before the typeof guard
        // this single value was enough to turn a malformed request body into
        // permission to write sellable material from a document. Kept as a
        // named regression rather than folded into the list above.
        [true, sourceUsageModes.VERIFICATION_ONLY],
        [false, sourceUsageModes.VERIFICATION_ONLY],
        [[1], sourceUsageModes.VERIFICATION_ONLY],

        [sourceUsageModes.VERIFICATION_ONLY, sourceUsageModes.VERIFICATION_ONLY],
        [sourceUsageModes.CONTENT_AND_VERIFICATION, sourceUsageModes.CONTENT_AND_VERIFICATION],
        [sourceUsageModes.CONTENT_ONLY, sourceUsageModes.CONTENT_ONLY],
    ];

    for (const [rawValue, expected] of normalisationCases)
    {
        assert(
            SourceUsageGate.normaliseUsageMode(rawValue) === expected,
            `normaliseUsageMode(${JSON.stringify(rawValue)}) is ${nameOfUsageMode(expected)}`,
        );
    }

    section("The two questions are asked separately, and they default in opposite directions");

    // [value, expected isContentUsage, expected isVerificationUsage]
    const predicateCases = [
        [sourceUsageModes.VERIFICATION_ONLY, false, true],
        [sourceUsageModes.CONTENT_AND_VERIFICATION, true, true],
        [sourceUsageModes.CONTENT_ONLY, true, false],
        [undefined, false, true],
        [null, false, true],
        [99, false, true],
        [-1, false, true],
        [true, false, true],
        ["CONTENT", false, true],
        [{}, false, true],
    ];

    for (const [rawValue, expectedContent, expectedVerification] of predicateCases)
    {
        assert(
            SourceUsageGate.isContentUsage(rawValue) === expectedContent,
            `isContentUsage(${JSON.stringify(rawValue)}) is ${expectedContent}`,
        );

        assert(
            SourceUsageGate.isVerificationUsage(rawValue) === expectedVerification,
            `isVerificationUsage(${JSON.stringify(rawValue)}) is ${expectedVerification}`,
        );
    }

    assert(
        SourceUsageGate.isContentUsage(undefined) === false
        && SourceUsageGate.isVerificationUsage(undefined) === true,
        "a row written before usageMode existed is still checked against, and still not written from — "
        + "the one combination that leaves every older deck behaving exactly as it did",
    );
}


// ── Tier 1: admission splits the two kinds ─────────────────────────────────

function runAdmissionShapeTier()
{
    section("Admission separates what may be written from from what may only be checked");

    const resolvedSources = [
        { informationSourceId: "a", usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION },
        { informationSourceId: "b", usageMode: sourceUsageModes.VERIFICATION_ONLY },
        { informationSourceId: "c", usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION },
        { informationSourceId: "d" },
        { informationSourceId: "e", usageMode: sourceUsageModes.CONTENT_ONLY },
    ];

    const contentSources = VerificationSourceAdmission.selectContentSources(resolvedSources);
    const verificationSources = SourceUsageGate.selectVerificationSources(resolvedSources);

    const sortedIdentifiersOf = (sources) => sources.map(source => source.informationSourceId).sort().join(",");

    assert(
        sortedIdentifiersOf(contentSources) === "a,c,e",
        "every content-bearing source is selected for generation, content-only included",
    );

    assert(
        sortedIdentifiersOf(verificationSources) === "a,b,c,d",
        "only the sources set to be checked against are selected for verification — the both-mode sources "
        + "and \"d\", which predates the field, are among them; the content-only \"e\" is not",
    );

    // The two sets are not complements, and the harness says so explicitly
    // because the temptation to derive one from the other by negation is exactly
    // what would break CONTENT_AND_VERIFICATION.
    assert(
        contentSources.some(source => verificationSources.includes(source)),
        "the two sets overlap — a source can be both written from and checked against",
    );

    for (const resolvedSource of resolvedSources)
    {
        assert(
            contentSources.includes(resolvedSource) || verificationSources.includes(resolvedSource),
            `"${resolvedSource.informationSourceId}" is read by at least one stage — a source in neither `
            + "set was attached for nothing",
        );
    }

    assert(
        VerificationSourceAdmission.selectContentSources([]).length === 0
        && VerificationSourceAdmission.selectContentSources(null).length === 0
        && SourceUsageGate.selectVerificationSources(null).length === 0
        && SourceUsageGate.selectVerificationSources(undefined).length === 0,
        "an empty or missing list yields nothing from either selector rather than throwing",
    );

    assert(
        VerificationSourceAdmission.MAXIMUM_CONTENT_SOURCES_PER_RUN
            < PaidDeckVerificationSourceQueryEngine.MAXIMUM_SOURCES_PER_DECK,
        "fewer sources may be GENERATED from than may be attached — a content source is held in memory "
        + "as a retrieval corpus for the whole mapping stage, on a box that has been OOM-killed before",
    );

    section("Both content-bearing modes are charged to the same budget");

    // The cap exists because of the corpus, and CONTENT_ONLY loads exactly the
    // same corpus. Counting only one of the two modes would let a run smuggle
    // through twice the memory the cap was written to bound.
    const contentBearingCount = SourceUsageGate.selectContentSources([
        ...Array.from({ length: 3 }, (unusedValue, sourceIndex) => (
            { informationSourceId: `content-only-${sourceIndex}`, usageMode: sourceUsageModes.CONTENT_ONLY })),
        ...Array.from({ length: 2 }, (unusedValue, sourceIndex) => (
            { informationSourceId: `both-${sourceIndex}`, usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION })),
    ]).length;

    assert(
        contentBearingCount === 5 && contentBearingCount > VerificationSourceAdmission.MAXIMUM_CONTENT_SOURCES_PER_RUN,
        "three content-only sources plus two both-mode sources count as five against the per-run cap of "
        + `${VerificationSourceAdmission.MAXIMUM_CONTENT_SOURCES_PER_RUN}, and are therefore refused`,
    );
}


// ── Tier 1: the declaration log labels events truthfully ───────────────────

function runDeclarationEventTier()
{
    section("Every declaration event is recorded as what it actually was");

    const knownEvents = SourceLicenceDeclarationQueryEngine.KNOWN_EVENTS;

    for (const eventName of ["ATTACHED", "DETACHED", "NOTE_UPDATED", "USAGE_CHANGED"])
    {
        assert(knownEvents.has(eventName), `${eventName} is a recognised event`);
    }

    // The regression this guards: record() used to coerce anything that was not
    // DETACHED into ATTACHED. A note edit would then have been permanently
    // logged as an attachment — a false entry in the one collection whose whole
    // value is that it is true.
    assert(
        !knownEvents.has("SOMETHING_ELSE"),
        "an invented event name is not silently accepted as known",
    );

    assert(
        typeof PaidDeckVerificationSourceQueryEngine.updateDeclaration === "function",
        "there is a way to correct a note or a usage mode",
    );

    for (const forbiddenMutator of ["update", "delete", "remove", "edit"])
    {
        assert(
            typeof SourceLicenceDeclarationQueryEngine[forbiddenMutator] !== "function",
            `the declaration log offers no ${forbiddenMutator}() — it is append-only`,
        );
    }
}


// ── Tier 2: Mongo ──────────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("An edit appends to the history rather than overwriting it");

    if (process.env.VERIFY_SOURCE_USAGE_DB !== "1")
    {
        skip("database tier (set VERIFY_SOURCE_USAGE_DB=1 to run)");
        return;
    }

    const deckId = `${TEST_PREFIX}deck-${Date.now()}`;
    const verificationSourceId = `${TEST_PREFIX}source-${Date.now()}`;
    const contentHash = `${TEST_PREFIX}hash-${Date.now()}`;

    try
    {
        await SourceLicenceDeclarationQueryEngine.record({
            event: SourceLicenceDeclarationQueryEngine.EVENT_ATTACHED,
            deckId: deckId,
            verificationSourceId: verificationSourceId,
            informationSourceId: `${TEST_PREFIX}info`,
            sourceName: "Licensed Textbook.pdf",
            sourceHash: contentHash,
            licenceType: sourceLicenceTypes.LICENSED_PERMISSION,
            licenceNote: "Publisher licence A-1",
            usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION,
            sourceNote: "Original note",
            declaredByUserId: `${TEST_PREFIX}user`,
        });

        await PaidDeckVerificationSourceQueryEngine.attach({
            id: verificationSourceId,
            deckId: deckId,
            informationSourceId: `${TEST_PREFIX}info`,
            name: "Licensed Textbook.pdf",
            sourceUrl: "",
            contentHash: contentHash,
            storagePath: `/InformationSources/${TEST_PREFIX}user/${contentHash}`,
            mimeType: "application/pdf",
            licenceType: sourceLicenceTypes.LICENSED_PERMISSION,
            licenceNote: "Publisher licence A-1",
            usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION,
            sourceNote: "Original note",
            declaredByUserId: `${TEST_PREFIX}user`,
            attachedAt: Date.now(),
            detachedAt: 0,
            active: true,
        });

        const storedSource = await PaidDeckVerificationSourceQueryEngine.findById(verificationSourceId);

        assert(
            storedSource !== null && storedSource.usageMode === sourceUsageModes.CONTENT_AND_VERIFICATION,
            "the attached row records that it may be written from",
        );

        assert(
            storedSource !== null && storedSource.sourceNote === "Original note",
            "the attached row records the administrator's note",
        );

        await SourceLicenceDeclarationQueryEngine.record({
            event: SourceLicenceDeclarationQueryEngine.EVENT_NOTE_UPDATED,
            deckId: deckId,
            verificationSourceId: verificationSourceId,
            sourceName: "Licensed Textbook.pdf",
            sourceHash: contentHash,
            licenceType: sourceLicenceTypes.LICENSED_PERMISSION,
            usageMode: sourceUsageModes.CONTENT_AND_VERIFICATION,
            sourceNote: "Corrected note — PO 4471",
            declaredByUserId: `${TEST_PREFIX}user`,
        });

        await PaidDeckVerificationSourceQueryEngine.updateDeclaration(verificationSourceId, {
            sourceNote: "Corrected note — PO 4471",
        });

        const declarations = await SourceLicenceDeclarationQueryEngine.findAllByDeckId(deckId);

        assert(declarations.length === 2, `the edit APPENDED an event (found ${declarations.length}, expected 2)`);

        assert(
            declarations[0].event === "ATTACHED" && declarations[0].sourceNote === "Original note",
            "the original attachment and its original note are still there, unmodified",
        );

        assert(
            declarations[1].event === "NOTE_UPDATED",
            `the edit is labelled NOTE_UPDATED, not coerced to ATTACHED (got ${declarations[1].event})`,
        );

        const updatedSource = await PaidDeckVerificationSourceQueryEngine.findById(verificationSourceId);

        assert(
            updatedSource !== null && updatedSource.sourceNote === "Corrected note — PO 4471",
            "the working-set row carries the corrected note",
        );

        assert(
            updatedSource !== null && updatedSource.licenceType === sourceLicenceTypes.LICENSED_PERMISSION,
            "the licence is untouched by a note edit — it is not editable through this path",
        );

        const heldHashes = await SourceLicenceDeclarationQueryEngine.findReferencedSourceHashesForUser(`${TEST_PREFIX}user`);

        assert(
            heldHashes.has(contentHash),
            "the document is STILL held against deletion after the edit — the proof behind every card "
            + "written from it must outlive an edit to its note",
        );

        // A detached source is a historical fact; editing what it was used for
        // would rewrite what the deck was written from.
        await PaidDeckVerificationSourceQueryEngine.detach(verificationSourceId, Date.now());

        const editAfterDetach = await PaidDeckVerificationSourceQueryEngine.updateDeclaration(
            verificationSourceId, { sourceNote: "Should not apply" });

        assert(editAfterDetach === false, "a detached source cannot be edited");

        const detachedSource = await PaidDeckVerificationSourceQueryEngine.findById(verificationSourceId);

        assert(
            detachedSource !== null && detachedSource.sourceNote === "Corrected note — PO 4471",
            "...and its note is unchanged by the attempt",
        );

        const hashesAfterDetach = await SourceLicenceDeclarationQueryEngine.findReferencedSourceHashesForUser(`${TEST_PREFIX}user`);

        assert(
            hashesAfterDetach.has(contentHash),
            "a DETACHED source's document is still held — it is still what the deck was written from",
        );
    }
    finally
    {
        const database = await DatabaseConnector.getDatabase();
        await database.collection(DatabaseConstants.SOURCE_LICENCE_DECLARATIONS_COLLECTION).deleteMany({ deckId: deckId });
        await database.collection(DatabaseConstants.PAID_DECK_VERIFICATION_SOURCES_COLLECTION).deleteMany({ deckId: deckId });
        console.log("  (fixtures removed)");
    }
}


async function main()
{
    console.log("Verifying the source usage gate\n");

    runUsageGateTier();
    runAdmissionShapeTier();
    runDeclarationEventTier();
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
