/**
 * VerifyContentRefinement — harness for AI-assisted content refinement.
 *
 * Run from the Dock directory:
 *     node VerifyContentRefinement.mjs
 *     VERIFY_CONTENT_REFINEMENT_DB=1 node VerifyContentRefinement.mjs
 *
 * Tier 1 is pure and always runs. Tiers 2+ touch Mongo and are opt-in behind the
 * env flag, following the same shape as VerifyPaidDeckPublishGate.
 *
 * What it protects, in the order the failures would hurt:
 *
 *   SILENT LOST UPDATES. The refinement write stamps a lastModified that beats
 *   anything stored, because SyncApplier discards a pulled change that is not
 *   strictly newer — which means the write ALWAYS wins against an unsynced edit
 *   on the owner's device. The base-content-hash check is the only thing
 *   standing between "correct a typo" and "destroy an afternoon of offline
 *   work", so it is checked from both directions: a matching hash writes, a
 *   stale one writes NOTHING.
 *
 *   DESTROYED EVIDENCE. A licence declaration is worth nothing once the document
 *   it describes is gone, and every retention rule in the product would
 *   eventually delete it — isSourceDue never read retentionMode, so "PERMANENT"
 *   was never protection. The hold is checked in both directions too: a
 *   referenced source survives, an unreferenced one is still reaped. A hold that
 *   over-blocks would quietly disable the retention promise.
 *
 *   THE WRONG PASSAGE CORRECTED. A flag quotes model-authored prose, and
 *   near-duplicate wording across sibling topics is normal rather than
 *   exceptional. Resolving to a single candidate when several match would
 *   eventually apply a correction to a passage nobody reviewed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const RefinedEntityWriter = require("./Globals/Classes/Generation/RefinedEntityWriter");
const RefinementTargetLocator = require("./Globals/Classes/Generation/RefinementTargetLocator");
const ContentRefinementApplier = require("./Globals/Classes/Generation/ContentRefinementApplier");
const ContentRefinementQueryEngine = require("./Globals/Classes/Database/ContentRefinementQueryEngine");
const SourceRetentionPolicy = require("./Globals/Classes/Content/SourceRetentionPolicy");
const CreditConfiguration = require("./Globals/Classes/Credits/CreditConfiguration");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const InformationSource = require("./Globals/Model/InformationSource");
const { refinementTargetKinds } = require("./Globals/Enumerations/RefinementTargetKinds");
const { sourceLicenceTypes } = require("./Globals/Enumerations/SourceLicenceTypes");

const TEST_NAME_PREFIX = "verify-content-refinement-";

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

function buildInformationSource(contentHash, uploadedAtMilliseconds, expiresAtMilliseconds = 0)
{
    return new InformationSource
    ({
        name: "reference.pdf",
        userId: "user-1",
        sourceType: 0,
        directoryPath: "/InformationSources/user-1",
        hash: contentHash,
        uploadedAt: uploadedAtMilliseconds,
        expiresAt: expiresAtMilliseconds,
        retentionMode: 1,
        licenceType: sourceLicenceTypes.CC0,
    });
}

// ── Tier 1: pure ───────────────────────────────────────────────────────────

function runContentHashTier()
{
    section("Content hashing detects the changes the concurrency guard depends on");

    const originalContent = "<p>The gas constant is 8.314 J/(mol K).</p>";

    assert(
        RefinedEntityWriter.computeContentHash(originalContent) === RefinedEntityWriter.computeContentHash(originalContent),
        "The same content hashes the same way twice",
    );
    assert(
        RefinedEntityWriter.computeContentHash(originalContent) !== RefinedEntityWriter.computeContentHash(originalContent + " "),
        "A whitespace-only difference is a DIFFERENT hash — the proposal did not see that version",
    );
    assert(
        RefinedEntityWriter.computeContentHash("") === RefinedEntityWriter.computeContentHash(null),
        "Empty and null hash alike, so a missing field cannot masquerade as a specific version",
    );

    section("Only writable target kinds are accepted");

    assert(RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.STUDY_MATERIAL), "STUDY_MATERIAL is writable");
    assert(RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.CARD_QUESTION), "CARD_QUESTION is writable");
    assert(RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.CARD_ANSWER), "CARD_ANSWER is writable");
    assert(
        !RefinedEntityWriter.isWritableTargetKind(refinementTargetKinds.FIGURE),
        "FIGURE is not writable directly — it must be resolved to the field holding the figure first",
    );
    assert(!RefinedEntityWriter.isWritableTargetKind(999), "An unrecognised kind is refused");

    const questionDefinition = RefinedEntityWriter.describeTargetKind(refinementTargetKinds.CARD_QUESTION);
    const answerDefinition = RefinedEntityWriter.describeTargetKind(refinementTargetKinds.CARD_ANSWER);

    assert(
        questionDefinition.contentFieldName === "question" && answerDefinition.contentFieldName === "answer",
        "Question and answer map to separate fields, so a flag about one cannot rewrite the other",
    );
}

function runMatchNormalisationTier()
{
    section("Quoted-text matching survives the formatting the generator adds");

    const normalize = RefinementTargetLocator.normalizeForMatching;

    assert(
        normalize("<p>The <strong>value</strong> is 8.314</p>") === "the value is 8.314",
        "Markup is stripped so a flag quoting plain prose still finds a formatted passage",
    );
    assert(
        normalize("a&nbsp;b") === "a b" && normalize("x &amp; y") === "x & y",
        "The entities models most often re-spell are resolved",
    );
    assert(
        normalize("“quoted”  and  ‘single’") === "\"quoted\" and 'single'",
        "Smart quotes are folded, and runs of whitespace collapsed",
    );
    assert(normalize(null) === "" && normalize(12) === "", "Non-strings normalise to empty rather than throwing");
}

function runRetentionHoldTier()
{
    section("A cited reference document outlives the retention rules");

    const heldSource = buildInformationSource("hash-held", 1000);
    const unheldSource = buildInformationSource("hash-unheld", 1000);
    const referencedProofHashes = new Set(["hash-held"]);

    const lapsedPolicy = { bRetained: false, deleteBeforeMilliseconds: null, reason: "post-subscription grace elapsed" };
    const freeTierPolicy = { bRetained: false, deleteBeforeMilliseconds: 5000, reason: "free tier" };
    const nowMilliseconds = 10000;

    assert(
        SourceRetentionPolicy.isSourceUnderLegalHold(heldSource, referencedProofHashes),
        "A referenced hash is recognised as held",
    );
    assert(
        !SourceRetentionPolicy.isSourceUnderLegalHold(unheldSource, referencedProofHashes),
        "An unreferenced hash is not held",
    );
    assert(
        !SourceRetentionPolicy.isSourceUnderLegalHold(heldSource, null),
        "A caller that did not look up the holds gets 'no hold', so a forgotten lookup cannot disable the reaper",
    );

    assert(
        SourceRetentionPolicy.isSourceDue(unheldSource, lapsedPolicy, nowMilliseconds, referencedProofHashes) === true,
        "An UNREFERENCED source is still reaped after a lapsed subscription — the hold does not over-block",
    );
    assert(
        SourceRetentionPolicy.isSourceDue(heldSource, lapsedPolicy, nowMilliseconds, referencedProofHashes) === false,
        "A referenced source survives a lapsed subscription, which is exactly when proof is most likely wanted",
    );
    assert(
        SourceRetentionPolicy.isSourceDue(heldSource, freeTierPolicy, nowMilliseconds, referencedProofHashes) === false,
        "A referenced source survives free-tier ageing",
    );

    const expiredHeldSource = buildInformationSource("hash-held", 1000, 2000);
    assert(
        SourceRetentionPolicy.isSourceDue(expiredHeldSource, lapsedPolicy, nowMilliseconds, referencedProofHashes) === false,
        "The hold outranks even an explicit TEMPORARY expiry stamp",
    );

    assert(
        SourceRetentionPolicy.isSourceDue(unheldSource, lapsedPolicy, nowMilliseconds) === true,
        "Called without the hold set at all, the pre-existing behaviour is unchanged",
    );
}

function runCreditRuleTier()
{
    section("Refinement carries configured credit rules");

    const configuration = new CreditConfiguration({});
    const bAdded = configuration.ensureContentRefinementTaskRules();

    assert(bAdded === true, "Both rules are backfilled into a fresh configuration");

    const { taskTypes } = require("./Globals/Enumerations/TaskTypes");
    const contentRule = configuration.getRuleForTask(taskTypes.REFINE_CONTENT);
    const visualRule = configuration.getRuleForTask(taskTypes.REFINE_VISUAL);

    assert(contentRule !== null && contentRule.getEnabled(), "REFINE_CONTENT has an enabled rule — an absent rule would be free");
    assert(visualRule !== null && visualRule.getEnabled(), "REFINE_VISUAL has an enabled rule");
    assert(
        visualRule.evaluate({}) > contentRule.evaluate({}),
        "A diagram refinement costs more than a text one — it drives premium generation plus a vision review",
    );

    assert(
        configuration.ensureContentRefinementTaskRules() === false,
        "A second call adds nothing, so an admin's tuned or disabled rule is never overwritten",
    );
}

// ── Tier 2: database ───────────────────────────────────────────────────────

async function runDatabaseTier()
{
    section("Applying a revision (database)");

    if (process.env.VERIFY_CONTENT_REFINEMENT_DB !== "1")
    {
        skip("Database tier — set VERIFY_CONTENT_REFINEMENT_DB=1 to run it");
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

    const testUserId = `${TEST_NAME_PREFIX}user-${Date.now()}`;
    const studyMaterialId = `${TEST_NAME_PREFIX}sm-${Date.now()}`;
    const deckId = `${TEST_NAME_PREFIX}deck-${Date.now()}`;

    const studyMaterialsCollection = database.collection(DatabaseConstants.STUDY_MATERIALS_COLLECTION);
    const refinementsCollection = database.collection(DatabaseConstants.CONTENT_REFINEMENTS_COLLECTION);

    const originalContent = "<p>The gas constant is 8.0 J/(mol K).</p>";
    const revisedContent = "<p>The gas constant is 8.314 J/(mol K).</p>";
    const storedLastModified = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    try
    {
        await studyMaterialsCollection.insertOne
        ({
            userId: testUserId,
            serverUpdatedAt: new Date(),
            data:
            {
                id: studyMaterialId,
                deckId: deckId,
                content: originalContent,
                // Deliberately AHEAD of the server clock, so the stamped value
                // has to beat a future timestamp rather than just "now".
                lifecycle: { lastModified: storedLastModified, creationDate: new Date().toISOString() },
            },
        });

        const readState = await RefinedEntityWriter.readTargetContent(testUserId, studyMaterialId, refinementTargetKinds.STUDY_MATERIAL);

        assert(readState.bFound && readState.contentValue === originalContent, "The stored content is read back for the proposal");
        assert(readState.deckId === deckId, "The owning deck travels with it, so the refinement record can be filed against it");

        const staleResult = await RefinedEntityWriter.applyRevision
        ({
            ownerUserId: testUserId,
            entityId: studyMaterialId,
            targetKind: refinementTargetKinds.STUDY_MATERIAL,
            revisedContent: revisedContent,
            expectedBaseContentHash: "a-hash-from-some-older-version",
        });

        assert(staleResult.bWritten === false && staleResult.reason === "BASE_CONTENT_CHANGED", "A stale base hash is refused");

        const afterStale = await studyMaterialsCollection.findOne({ userId: testUserId, "data.id": studyMaterialId });
        assert(afterStale.data.content === originalContent, "…and NOTHING was written — this is the lost-update guard");

        const applyResult = await RefinedEntityWriter.applyRevision
        ({
            ownerUserId: testUserId,
            entityId: studyMaterialId,
            targetKind: refinementTargetKinds.STUDY_MATERIAL,
            revisedContent: revisedContent,
            expectedBaseContentHash: readState.contentHash,
        });

        assert(applyResult.bWritten === true, "A matching base hash writes");

        const afterApply = await studyMaterialsCollection.findOne({ userId: testUserId, "data.id": studyMaterialId });
        assert(afterApply.data.content === revisedContent, "The revision landed");
        assert(
            new Date(afterApply.data.lifecycle.lastModified).getTime() > new Date(storedLastModified).getTime(),
            "lastModified beat a stored timestamp an hour in the future — otherwise the client discards the pull",
        );

        const secondApply = await RefinedEntityWriter.applyRevision
        ({
            ownerUserId: testUserId,
            entityId: studyMaterialId,
            targetKind: refinementTargetKinds.STUDY_MATERIAL,
            revisedContent: "<p>Something else.</p>",
            expectedBaseContentHash: readState.contentHash,
        });

        assert(secondApply.bWritten === false, "Re-applying the same proposal is refused — the content moved on");

        const foreignRead = await RefinedEntityWriter.readTargetContent("some-other-user", studyMaterialId, refinementTargetKinds.STUDY_MATERIAL);
        assert(foreignRead.bFound === false, "Another user's id does not reach this entity");

        section("Recording the refinement (database)");

        const applierResult = await ContentRefinementApplier.apply
        ({
            ownerUserId: testUserId,
            actorUserId: testUserId,
            entityId: studyMaterialId,
            targetKind: refinementTargetKinds.STUDY_MATERIAL,
            revisedContent: originalContent,
            expectedBaseContentHash: RefinedEntityWriter.computeContentHash(revisedContent),
            instruction: "Put it back.",
            summary: "Reverted.",
            modelIdentifier: "gemini-3.1-flash-lite",
            consultedUrls: ["https://example.org/gas-constant"],
            attachedSource:
            {
                informationSourceId: "src-1",
                name: "reference.pdf",
                contentHash: "hash-proof",
                sourceUrl: "",
                licenceType: sourceLicenceTypes.CC0,
                licenceNote: "Public data",
            },
            mainTaskId: null,
            flagIndex: null,
        });

        assert(applierResult.bApplied === true, "The applier writes and records in one call");
        assert(applierResult.refinement !== null, "A refinement record came back");
        assert(applierResult.refinement.sourceHash === "hash-proof", "The proof hash is recorded — the retention hold keys on it");
        assert(applierResult.refinement.licenceType === sourceLicenceTypes.CC0, "The declared licence is recorded");

        const heldHashes = await ContentRefinementQueryEngine.findReferencedSourceHashesForUser(testUserId);
        assert(heldHashes.has("hash-proof"), "The hold lookup finds the hash the refinement cited");

        const deckRefinements = await ContentRefinementQueryEngine.findAllByDeckId(deckId);
        assert(deckRefinements.length === 1, "The refinement is reachable by deck for the audit trail");

        assert(
            typeof ContentRefinementQueryEngine.update === "undefined" && typeof ContentRefinementQueryEngine.delete === "undefined",
            "The engine exposes no update or delete — an editable record evidences nothing",
        );
    }
    finally
    {
        await studyMaterialsCollection.deleteMany({ userId: testUserId });
        await refinementsCollection.deleteMany({ ownerUserId: testUserId });
    }
}

/**
 * The client-side invariants of applying ONE instruction to SEVERAL entities.
 *
 * Asserted against the source rather than driven in a browser because the
 * refinement page is reached through a deck context menu, and no context-menu
 * action navigates under Puppeteer — a pre-existing harness limitation that
 * affects Insights, Browse and Edit identically and is why
 * run_refinement_ui_checks.js measures stand-in markup. What is checked here is
 * exactly the set of properties whose failure is SILENT and expensive: paying
 * several times for the same entity, a batch that dies on its first bad item,
 * and a selection that vanishes when the reviewer types in the search box.
 */
function runBatchRefinementTier()
{
    section("Refining a selection");

    const pageSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "ContentRefinement", "ContentRefinementPage.js"), "utf8");
    const runnerSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "ContentRefinement", "Classes", "BatchRefinementRunner.js"), "utf8");

    // getCards / getStudyMaterials default to RECURSIVE. Letting that default
    // stand while also walking the sub-decks listed every entity once per
    // ancestor — cosmetic while one row could be selected, and a billing bug the
    // moment "select all" exists, because each duplicate is a separate charged
    // proposal and every copy after the first fails the base-content check.
    assert(pageSource.includes("deck.getStudyMaterials(false)"), "Study materials are collected from THIS deck only, so the walk cannot list one twice");
    assert(pageSource.includes("deck.getCards(false)"), "Cards are collected from THIS deck only, for the same reason");

    // The selection is held against row ELEMENTS, so rebuilding the list on
    // every keystroke would silently drop a selection assembled over a minute.
    assert(pageSource.includes("entityRow.hidden ="), "Searching hides and shows rows rather than rebuilding the list, so a selection survives typing");
    assert(pageSource.includes("this.getVisibleRows()"), "A shift-range spans VISIBLE rows, so it cannot reach past the current search term into entities the reviewer cannot see");

    // Selection and preview are separate state. If they were not, inspecting one
    // item of a selection would destroy the rest — which is the entire reason
    // the right-click entry exists.
    assert(pageSource.includes("#previewAnchorIndex"), "The previewed passage is tracked separately from the selection");
    assert(pageSource.includes("setPreviewAnchor(entityIndex)") || pageSource.includes("setPreviewAnchor("), "...and can be moved on its own");
    assert(pageSource.includes("is-preview-anchor"), "...and is marked differently from a selected row, so the two states are distinguishable");

    // Figure ordinals address one passage. Offering them across a selection
    // would build an address that names an entity the reviewer did not pick.
    assert(pageSource.includes("this.#selection.getSelectionCount() > 1"), "Diagram actions are withheld once more than one entity is selected");

    // One proposal per entity, reviewed before anything is written.
    assert(runnerSource.includes("for (let entityIndex = 0"), "The run is sequential — concurrent proposals would be concurrent model-loading workers");
    assert(runnerSource.includes("RefinementProposalDialog.show"), "Every proposal is still shown before it is applied");
    assert(runnerSource.includes("await SyncManager.sync();"), "The run syncs once up front rather than once per item");

    // A 402 or a 403 will refuse every remaining item for the same reason, so
    // continuing would be N identical dialogs. Anything else is specific to one
    // entity and must not kill the run.
    assert(runnerSource.includes("refinementError.creditDetail || refinementError.entitlementDetail"), "Out of credits and not-in-plan end the run");
    assert(runnerSource.includes("runOutcome.failures.push"), "...while a per-entity failure is recorded and the run continues");
    assert(runnerSource.includes("RESULT_STOPPED"), "The reviewer can stop a run part-way, keeping what was already applied");

    // A two-minute wait with nothing on screen is indistinguishable from a hung
    // app, and the only signal this flow had was a label on the submit button —
    // the one control that could be scrolled off the bottom of the page.
    const overlaySource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Pages", "ContentRefinement", "Components", "RefinementProgressOverlay.js"), "utf8");
    assert(overlaySource.includes("setDismissible(false)"), "The progress overlay cannot be dismissed with Escape while a call is in flight");
    assert(overlaySource.includes("isStopRequested"), "...and a run can be stopped from it");
    assert(!overlaySource.includes("this.#bStopRequested = false;"), "...without the stop being forgotten when the overlay is re-shown between items");
    assert(runnerSource.includes("progressOverlay.close()") && runnerSource.includes("progressOverlay.open("), "The overlay comes down for each review and back up afterwards, rather than stacking two modals");

    // The app's only page-level scroller is the [page] rule; an element without
    // the attribute overflows the viewport and is clipped with no scrollbar.
    assert(pageSource.includes('this.setAttribute("page", "")'), "The refinement page opts into the app's page scroller, so its submit button is reachable");
}

/**
 * The before/after panes.
 *
 * These used to show a wall of plain text: the diff builder flattened both
 * sides to textContent, deleted every figure, and re-emitted escaped words. It
 * was a correct comparison and a useless review surface — the reviewer was
 * asked to approve a lesson while looking at something that was not one.
 */
function runComparisonRenderingTier()
{
    section("The comparison shows the passage, not a transcript of it");

    const diffSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "Globals", "Classes", "HtmlDiffBuilder.js"), "utf8");
    const dialogSource = fs.readFileSync(path.join(currentDirectory, "..", "Main", "CommonComponents", "RefinementProposalDialog.js"), "utf8");

    // Asserted against the METHOD that did the flattening, not the phrase — the
    // class comment names the old behaviour to explain why this one exists, and
    // a substring check would match the explanation rather than the code.
    assert(!diffSource.includes("#extractComparableText"), "The diff no longer flattens the passage to text");
    assert(!diffSource.includes("static #escape"), "...and no longer re-escapes it by hand, because nothing leaves a Text node");
    assert(diffSource.includes("createTreeWalker"), "...it walks the parsed document instead");
    assert(diffSource.includes("splitText"), "...and marks words in place rather than re-emitting them");
    assert(diffSource.includes("parsedDocument.body.innerHTML"), "...returning real markup for both panes");

    // FILTER_REJECT prunes the subtree; FILTER_SKIP would still descend. That
    // difference is the whole mechanism by which a figure stays in the rendered
    // pane while contributing no words to the comparison.
    assert(diffSource.includes("FILTER_REJECT"), "Skipped subtrees are pruned, so a figure renders without being diffed");
    assert(diffSource.includes("pre.mermaid"), "Mermaid source is not marked — the renderer replaces it a frame later anyway");
    assert(diffSource.includes("MATH_DELIMITER_PATTERN"), "A text node holding KaTeX delimiters is atomic, or the equation silently stops typesetting");

    // The dialog's own header claimed both panes were sanitised. It was true of
    // the visual pane and false of the text one for as long as the text diff
    // emitted its own escaped string.
    assert(
        (dialogSource.match(/HtmlSanitizer\.sanitize\(difference\./g) || []).length === 2,
        "Both text panes are sanitised, which the class comment always claimed",
    );
    assert(dialogSource.includes("bComparisonTooLarge"), "A passage too large to highlight says so rather than being marked everywhere");
    assert(dialogSource.includes("refinement-rendered-passage"), "The panes carry the shared passage typography");
}

/**
 * A refinement that failed used to leave no trace anywhere: the endpoint
 * returned 502 with a sentence written for the reviewer and logged nothing, and
 * the worker's stderr — which carries the reply length and its first characters,
 * the whole diagnosis — was discarded on exactly that path. An error a user can
 * see and an operator cannot is a bug that lasts.
 */
function runDiagnosticsTier()
{
    section("A failed refinement leaves evidence on the server");

    const runnerSource = fs.readFileSync(path.join(currentDirectory, "Globals/Classes/Generation/RefinementProposalRunner.js"), "utf8");
    const endpointSource = fs.readFileSync(path.join(currentDirectory, "Endpoints/AutomaticGeneration/Helpers/ContentRefinementRunner.js"), "utf8");

    assert(runnerSource.includes("workerFailure.workerStandardError"), "The worker's stderr is attached to the rejection rather than discarded");
    assert(runnerSource.includes("MAXIMUM_ATTACHED_STANDARD_ERROR_CHARACTERS"), "...capped, so a chatty worker cannot flood the log store");
    assert(runnerSource.includes(".slice(-RefinementProposalRunner"), "...taking the TAIL, because the diagnosis is whatever it said last");

    assert(endpointSource.includes("#recordWorkerFailure"), "Both worker failures are recorded");
    assert(
        (endpointSource.match(/#recordWorkerFailure\(/g) || []).length === 3,
        "...from the text path, the visual path, and the one definition",
    );
    assert(endpointSource.includes("workerStandardError: workerError.workerStandardError"), "...carrying the worker's own diagnosis into the record");

    // The passage and the reviewer's instruction are reported as lengths by the
    // worker and must never be copied into a log record as content.
    assert(!endpointSource.includes("beforeHtml: workerError"), "The passage itself is never written to the log");
    assert(!endpointSource.includes("instruction: instruction,\n                    worker"), "...and neither is the reviewer's typed instruction");
}

async function main()
{
    console.log("Verifying content refinement...\n");

    runContentHashTier();
    runMatchNormalisationTier();
    runRetentionHoldTier();
    runCreditRuleTier();
    runBatchRefinementTier();
    runComparisonRenderingTier();
    runDiagnosticsTier();
    await runDatabaseTier();

    console.log(`\nPassed: ${passedCount}   Failed: ${failedCount}   Skipped: ${skippedCount}`);
    process.exit(failedCount > 0 ? 1 : 0);
}

main().catch((fatalError) =>
{
    console.error("FATAL", fatalError);
    process.exit(1);
});
