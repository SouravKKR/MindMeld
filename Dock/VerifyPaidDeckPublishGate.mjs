/**
 * End-to-end verification harness for the paid-deck publish review gate and the
 * listing-to-provenance link it depends on.
 *
 * Run from the Dock directory:
 *     node VerifyPaidDeckPublishGate.mjs
 *     VERIFY_PAID_DECK_GATE_DB=1 node VerifyPaidDeckPublishGate.mjs
 *
 *   1. ALWAYS — pure checks on the gate's decision rules and on the link
 *      resolver's fallback, with no database and no key material required.
 *
 *   2. DB (opt-in: VERIFY_PAID_DECK_GATE_DB=1) — drives the real
 *      PaidDeckPublishService against MongoDB. This tier is the point of the
 *      harness. The gate was inert for its whole life because provenance is
 *      filed under the SOURCE deck's id while the gate was evaluated against
 *      the LISTING's id, and the two never coincide — a bug no unit test on the
 *      gate itself could ever catch, because the gate was always correct in
 *      isolation. What has to be proven is that a publish through the real
 *      service, with the ids the real client sends, actually gets refused.
 *
 *      Requires PAID_DECK_MASTER_KEY_BASE64 to be a valid 32-byte key, since a
 *      publish that never reaches encryption proves nothing about the publish
 *      path. The tier skips rather than fails when it is absent.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const PaidDeckPublishGate = require("./Globals/Classes/Generation/PaidDeckPublishGate");
const PaidDeckProvenanceLinkResolver = require("./Globals/Classes/Generation/PaidDeckProvenanceLinkResolver");
const PaidDeckGenerationRunLocator = require("./Globals/Classes/Generation/PaidDeckGenerationRunLocator");
const { renderAuditTrailPdf } = require("./Endpoints/Admin/PaidDecks/DownloadAuditTrail");
const PaidDeckPublishService = require("./Globals/Classes/PaidDeck/PaidDeckPublishService");
const PaidDeckStorefrontProjection = require("./Globals/Classes/PaidDeck/PaidDeckStorefrontProjection");
const GenerationProvenanceQueryEngine = require("./Globals/Classes/Database/GenerationProvenanceQueryEngine");
const KeyManagementService = require("./Globals/Classes/Security/KeyManagementService");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const ErrorCodes = require("./Globals/Constants/ErrorCodes");

const TEST_NAME_PREFIX = "verify-publish-gate-";

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
 * A minimal export-bundle payload in the shape the upload dialog emits — a
 * `{ metadata, data: [...] }` with one flat deck carrying one card.
 */
function buildDeckPayload(deckName)
{
    return {
        metadata: { name: deckName, exportDate: new Date().toUTCString() },
        data:
        [
            {
                id: `${TEST_NAME_PREFIX}payload-deck`,
                name: deckName,
                parent: null,
                subDecks: [],
                studyMaterials: [],
                mockTests: [],
                cards: [{ id: `${TEST_NAME_PREFIX}payload-card`, question: "Q", answer: "A" }],
                additionalData: {}
            }
        ]
    };
}

function buildBlockingFlag(problemText)
{
    return {
        category: "CONSTANT",
        severity: "blocking",
        source: "REFERENCE_SET",
        topicChain: ["Root", "Topic"],
        quotedText: "The speed of light is 3.5e8 m/s.",
        problem: problemText,
        correctStatement: "The speed of light is 2.998e8 m/s."
    };
}


async function runAlwaysOnTier()
{
    section("Tier 1 — gate decision rules (no database required)");

    // The clearing-resolution allow-list. An arbitrary string must not clear a
    // flag, or "looked at it" would silently read as a clearance later.
    assert(PaidDeckPublishGate.isClearingResolution("FIXED") === true, "FIXED clears a flag");
    assert(PaidDeckPublishGate.isClearingResolution("NOT_A_PROBLEM") === true, "NOT_A_PROBLEM clears a flag");
    assert(PaidDeckPublishGate.isClearingResolution("looked at it") === false, "an arbitrary string does not clear a flag");
    assert(PaidDeckPublishGate.isClearingResolution("") === false, "an empty resolution does not clear a flag");

    // The resolver must never hand back a blank id: every caller feeds the
    // result straight into a provenance lookup.
    const resolvedFromBlank = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId("");
    assert(resolvedFromBlank === "", "the link resolver returns blank for a blank listing id");

    // The link names decks inside the publisher's library. The storefront
    // endpoints hand back the stored document almost verbatim, so without this
    // projection every new schema field reaches every visitor by default.
    const buyerFacingDocument = PaidDeckStorefrontProjection.forBuyer
    ({
        id: "listing-1",
        title: "A deck",
        sourceDeckId: "private-deck-1",
        provenanceDeckId: "private-deck-1"
    });

    assert(buyerFacingDocument.sourceDeckId === undefined, "the storefront projection strips sourceDeckId");
    assert(buyerFacingDocument.provenanceDeckId === undefined, "the storefront projection strips provenanceDeckId");
    assert(buyerFacingDocument.title === "A deck", "the storefront projection keeps buyer-facing fields");
}


async function runDatabaseTier()
{
    section("Tier 2 — live publish path (opt-in: VERIFY_PAID_DECK_GATE_DB=1)");

    if (process.env.VERIFY_PAID_DECK_GATE_DB !== "1")
    {
        skip("Database tier not requested — set VERIFY_PAID_DECK_GATE_DB=1 with Mongo running");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("Database tier — MongoDB is not reachable");
        return;
    }

    // Dock calls this during boot; a harness that drives the service directly
    // has to do it itself or every publish fails as KEY_MANAGEMENT_NOT_READY.
    KeyManagementService.initialize();

    if (!KeyManagementService.isReady())
    {
        skip("Database tier — PAID_DECK_MASTER_KEY_BASE64 is unset or not 32 bytes, so no publish can complete");
        return;
    }

    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const provenanceCollection = database.collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

    const uniqueSuffix = `${Date.now()}`;
    const publisherUserId = `${TEST_NAME_PREFIX}publisher-${uniqueSuffix}`;

    // The two ids that were conflated. Distinct here on purpose, exactly as the
    // real upload dialog produces them.
    const sourceDeckId = `${TEST_NAME_PREFIX}source-deck-${uniqueSuffix}`;
    const flaggedListingId = `${TEST_NAME_PREFIX}listing-flagged-${uniqueSuffix}`;
    const unverifiedSourceDeckId = `${TEST_NAME_PREFIX}source-unverified-${uniqueSuffix}`;
    const unverifiedListingId = `${TEST_NAME_PREFIX}listing-unverified-${uniqueSuffix}`;
    const cleanListingId = `${TEST_NAME_PREFIX}listing-clean-${uniqueSuffix}`;
    const legacyListingId = `${TEST_NAME_PREFIX}listing-legacy-${uniqueSuffix}`;

    const createdListingIds = [flaggedListingId, unverifiedListingId, cleanListingId, legacyListingId];
    const createdProvenanceDeckIds = [sourceDeckId, unverifiedSourceDeckId];

    try
    {
        // ── Fixture: a run that produced a deck and raised one blocking flag ──
        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: `${TEST_NAME_PREFIX}task-${uniqueSuffix}`,
            deckId: sourceDeckId,
            deckName: `${TEST_NAME_PREFIX}deck-${uniqueSuffix}`,
            generatedByUserId: publisherUserId,
            sources: [{ name: "syllabus.pdf", contentHash: "abc123", declaredSourceType: "CURRICULUM_OR_SYLLABUS" }],
            declaredSourceTypeNames: ["CURRICULUM_OR_SYLLABUS"],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [{ actionType: "GENERATION", modelIdentifier: "test-model-1", timestampUtcMilliseconds: Date.now() }],
            verification: { version: 1, verifiedEntityCount: 1, blockingFlagCount: 1, advisoryFlagCount: 0, flags: [buildBlockingFlag("Stated constant is wrong.")], summary: "1 blocking" },
            coverageReconciliation: null
        });

        // ── The regression this harness exists for ────────────────────────
        const blockedResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: flaggedListingId,
                title: "Flagged deck",
                isPublished: true,
                basePriceMinor: 1000,
                isPerpetual: true,
                sourceDeckId: sourceDeckId,
                provenanceDeckId: sourceDeckId
            },
            deckPayload: buildDeckPayload("Flagged deck"),
            publisherUserId: publisherUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(blockedResult.success === false, "a listing linked to a run with an unresolved blocking flag is refused");
        assert(blockedResult.reason === "PUBLISH_GATE", "the refusal is attributed to the publish gate");
        assert(blockedResult.error === ErrorCodes.PUBLISH_BLOCKED_BY_VERIFICATION_FLAGS, "the refusal carries the verification-flag error code");
        assert(Array.isArray(blockedResult.blockingFlags) && blockedResult.blockingFlags.length === 1, "the refusal names the one blocking flag");

        const writtenAfterRefusal = await paidDecksCollection.countDocuments({ id: flaggedListingId });
        assert(writtenAfterRefusal === 0, "a refused publish leaves no half-uploaded listing behind");

        // ── Resolving the flag lets the same publish through ──────────────
        const bRecorded = await GenerationProvenanceQueryEngine.recordFlagResolution(`${TEST_NAME_PREFIX}task-${uniqueSuffix}`,
        {
            flagIndex: 0,
            resolution: PaidDeckPublishGate.RESOLUTION_FIXED,
            note: "Corrected the constant.",
            actorUserId: publisherUserId
        });
        assert(bRecorded === true, "the resolution is appended to the provenance record");

        const allowedResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: flaggedListingId,
                title: "Flagged deck",
                isPublished: true,
                basePriceMinor: 1000,
                isPerpetual: true,
                sourceDeckId: sourceDeckId,
                provenanceDeckId: sourceDeckId
            },
            deckPayload: buildDeckPayload("Flagged deck"),
            publisherUserId: publisherUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(allowedResult.success === true, "the same publish succeeds once the blocking flag is resolved");

        const storedListing = await paidDecksCollection.findOne({ id: flaggedListingId });
        assert(storedListing?.provenanceDeckId === sourceDeckId, "the listing persists its provenance link");
        assert(storedListing?.sourceDeckId === sourceDeckId, "the listing persists its source deck");

        // The stamp that never landed while the ids were conflated.
        const stampedRecord = await GenerationProvenanceQueryEngine.findByDeckId(sourceDeckId);
        assert(typeof stampedRecord?.publishedAt === "number" || stampedRecord?.publishedAt instanceof Date || typeof stampedRecord?.publishedAt === "string",
            "publication is stamped into the provenance record");
        assert(stampedRecord?.publishedByUserId === publisherUserId, "the publication stamp names the publisher");

        // ── The link resolver bridges listing id -> provenance deck id ────
        const resolvedDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(flaggedListingId);
        assert(resolvedDeckId === sourceDeckId, "the link resolver maps a listing id to its source deck id");

        // ── A pipeline deck with no verification result is refused ────────
        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: `${TEST_NAME_PREFIX}task-unverified-${uniqueSuffix}`,
            deckId: unverifiedSourceDeckId,
            deckName: `${TEST_NAME_PREFIX}deck-unverified-${uniqueSuffix}`,
            generatedByUserId: publisherUserId,
            sources: [],
            declaredSourceTypeNames: [],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [],
            verification: null,
            coverageReconciliation: null
        });

        const unverifiedResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: unverifiedListingId,
                title: "Unverified deck",
                isPublished: true,
                isPerpetual: true,
                sourceDeckId: unverifiedSourceDeckId,
                provenanceDeckId: unverifiedSourceDeckId
            },
            deckPayload: buildDeckPayload("Unverified deck"),
            publisherUserId: publisherUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(unverifiedResult.success === false, "a pipeline deck whose verification never ran is refused");
        assert(unverifiedResult.reason === "PUBLISH_GATE", "the missing-verification refusal comes from the gate");

        // ── The retained policy: no provenance record means no gate ───────
        const cleanResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: cleanListingId,
                title: "Hand-made deck",
                isPublished: true,
                isPerpetual: true,
                sourceDeckId: `${TEST_NAME_PREFIX}handmade-${uniqueSuffix}`,
                provenanceDeckId: `${TEST_NAME_PREFIX}handmade-${uniqueSuffix}`
            },
            deckPayload: buildDeckPayload("Hand-made deck"),
            publisherUserId: publisherUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(cleanResult.success === true, "a deck with no provenance record still publishes (policy preserved)");

        // ── Legacy rows: no link, and behaviour unchanged ─────────────────
        const legacyResult = await PaidDeckPublishService.publish
        ({
            metadata: { id: legacyListingId, title: "Legacy listing", isPublished: true, isPerpetual: true },
            deckPayload: buildDeckPayload("Legacy listing"),
            publisherUserId: publisherUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(legacyResult.success === true, "a publish that sends no link still succeeds (no regression for old clients)");

        const legacyResolvedDeckId = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(legacyListingId);
        assert(legacyResolvedDeckId === legacyListingId, "an unlinked listing falls back to its own id, reproducing the old behaviour");
    }
    finally
    {
        try
        {
            await paidDecksCollection.deleteMany({ id: { $in: createdListingIds } });
            await provenanceCollection.deleteMany({ deckId: { $in: createdProvenanceDeckIds } });

            // The encrypted master must be swept explicitly. KeyManagementService
            // exposes no delete for it — every real deletion path removes a
            // superseded key version from inside a rotation — so leaving this to
            // a public API would silently leak an encrypted copy of every
            // fixture deck into the database on each run.
            await database.collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION).deleteMany({ deckId: { $in: createdListingIds } });
            await database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION).deleteMany({ deckId: { $in: createdListingIds } });
            await database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION).deleteMany({ deckId: { $in: createdListingIds } });
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`);
        }
    }
}


/**
 * Tier 3 reproduces the shape that defeated the gate in production, which tier 2
 * cannot: there, the listing's link pointed at the deck the record names, so the
 * lookup matched. In reality it did not.
 *
 * Runs used to file their record against the "Unit I: ..." deck they created,
 * while the tile an administrator picks to sell is its parent, "Chemistry". The
 * link was therefore honest and still missed, the audit trail 404'd, and — the
 * part that mattered — PaidDeckPublishGate found no record and allowed a deck
 * whose verification had never been read.
 *
 * New runs file against the launch deck instead, so this is now the LEGACY
 * placement — and it is kept exactly because it is legacy: every record written
 * before that change still sits on a child deck, and those decks must stay
 * reachable and gated. The fixture below is built the old way on purpose.
 */
/**
 * Renders one provenance record through the audit-trail endpoint's own renderer
 * and asserts a real PDF came out. Skips rather than fails when the Agent venv is
 * absent — a developer machine without it can still verify everything else.
 */
async function renderProvenancePayload(renderPayload, description)
{
    const agentVenvDirectory = path.join(currentDirectory, "..", "Agent", ".venv");

    if (!fs.existsSync(agentVenvDirectory))
    {
        skip(`${description} — the Agent venv is not present on this machine`);
        return 0;
    }

    const workingDirectory = path.join(os.tmpdir(), `verify-audit-trail-${Date.now()}-${Math.round(process.hrtime()[1] / 1000)}`);
    const provenanceJsonPath = path.join(workingDirectory, "provenance.json");
    const outputPdfPath = path.join(workingDirectory, "AuditTrail.pdf");

    try
    {
        await fs.promises.mkdir(workingDirectory, { recursive: true });
        await fs.promises.writeFile(provenanceJsonPath, JSON.stringify(renderPayload), "utf8");

        await renderAuditTrailPdf(provenanceJsonPath, outputPdfPath);

        const pdfBuffer = await fs.promises.readFile(outputPdfPath);

        assert(pdfBuffer.length > 1000 && pdfBuffer.subarray(0, 5).toString("latin1") === "%PDF-", description);

        return pdfBuffer.length;
    }
    catch (renderError)
    {
        assert(false, `${description} (${renderError.message})`);
        return 0;
    }
    finally
    {
        try { await fs.promises.rm(workingDirectory, { recursive: true, force: true }); }
        catch (cleanupError) { console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`); }
    }
}


async function runDeckTreeTier()
{
    section("Tier 3 — resolving a listing whose picked deck is not the record's deck");

    if (process.env.VERIFY_PAID_DECK_GATE_DB !== "1")
    {
        skip("Deck-tree tier not requested — set VERIFY_PAID_DECK_GATE_DB=1 with Mongo running");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("Deck-tree tier — MongoDB is not reachable");
        return;
    }

    const decksCollection = database.collection(DatabaseConstants.DECKS_COLLECTION);
    const paidDecksCollection = database.collection(DatabaseConstants.PAID_DECKS_COLLECTION);
    const provenanceCollection = database.collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

    const uniqueSuffix = `${Date.now()}`;
    const ownerUserId = `${TEST_NAME_PREFIX}owner-${uniqueSuffix}`;

    const mainTaskId = `${TEST_NAME_PREFIX}tree-task-${uniqueSuffix}`;
    const launchDeckId = `${TEST_NAME_PREFIX}launch-${uniqueSuffix}`;
    const producedDeckId = `${TEST_NAME_PREFIX}produced-${uniqueSuffix}`;
    const subDeckId = `${TEST_NAME_PREFIX}sub-${uniqueSuffix}`;

    // A second, unrelated run under one parent — the case where no single record
    // governs the deck and guessing one would mis-attribute the evidence.
    const mixedParentDeckId = `${TEST_NAME_PREFIX}mixed-${uniqueSuffix}`;
    const mixedFirstChildId = `${TEST_NAME_PREFIX}mixed-first-${uniqueSuffix}`;
    const mixedSecondChildId = `${TEST_NAME_PREFIX}mixed-second-${uniqueSuffix}`;

    const listingId = `${TEST_NAME_PREFIX}tree-listing-${uniqueSuffix}`;

    const createdDeckIds = [launchDeckId, producedDeckId, subDeckId, mixedParentDeckId, mixedFirstChildId, mixedSecondChildId];

    function buildDeckDocument(deckId, deckName, parentDeckId, markedMainTaskId)
    {
        const additionalData = markedMainTaskId
            ? { paidDeckGeneration: { mainTaskId: markedMainTaskId, generatedAt: new Date().toISOString() } }
            : {};

        return {
            userId: ownerUserId,
            data:
            {
                id: deckId,
                name: deckName,
                parent: parentDeckId,
                subDecks: [],
                additionalData: additionalData,
                lifecycle: { lastModified: new Date().toISOString() }
            },
            serverUpdatedAt: new Date()
        };
    }

    try
    {
        await decksCollection.insertMany
        ([
            // The launch deck is deliberately unmarked: it is a deck the user
            // already owned, and generation does not write to it.
            buildDeckDocument(launchDeckId, "Chemistry", "0", null),
            buildDeckDocument(producedDeckId, "Unit I: Fundamentals Of Chemistry", launchDeckId, mainTaskId),
            // Unmarked on purpose — the shape every deck generated before this fix
            // is in, and the one that forces the ancestor walk.
            buildDeckDocument(subDeckId, "Chemical Foundations", producedDeckId, null),

            buildDeckDocument(mixedParentDeckId, "Mixed library deck", "0", null),
            buildDeckDocument(mixedFirstChildId, "From run one", mixedParentDeckId, `${mainTaskId}-one`),
            buildDeckDocument(mixedSecondChildId, "From run two", mixedParentDeckId, `${mainTaskId}-two`)
        ]);

        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: mainTaskId,
            deckId: producedDeckId,
            deckName: "Unit I: Fundamentals Of Chemistry",
            generatedByUserId: ownerUserId,
            sources: [{ name: "syllabus.pdf", contentHash: "tree123", declaredSourceType: "CURRICULUM_OR_SYLLABUS" }],
            declaredSourceTypeNames: ["CURRICULUM_OR_SYLLABUS"],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [{ actionType: "GENERATION", modelIdentifier: "test-model-1", timestampUtcMilliseconds: Date.now() }],
            verification: { version: 1, verifiedEntityCount: 1, blockingFlagCount: 1, advisoryFlagCount: 0, flags: [buildBlockingFlag("Stated constant is wrong.")], summary: "1 blocking" },
            coverageReconciliation: null
        });

        // ── The locator, on each node of the tree ─────────────────────────
        assert(await PaidDeckGenerationRunLocator.findMainTaskId(producedDeckId) === mainTaskId,
            "the run is found on the deck that carries the marker");
        assert(await PaidDeckGenerationRunLocator.findMainTaskId(launchDeckId) === mainTaskId,
            "the run is found from the launch deck, by descending to the deck it produced");
        assert(await PaidDeckGenerationRunLocator.findMainTaskId(subDeckId) === mainTaskId,
            "the run is found from an unmarked sub-deck, by walking up to its generated parent");
        assert(await PaidDeckGenerationRunLocator.findMainTaskId(mixedParentDeckId) === "",
            "a deck holding content from two runs resolves to no run rather than guessing one");
        assert(await PaidDeckGenerationRunLocator.findMainTaskId(`${TEST_NAME_PREFIX}absent-${uniqueSuffix}`) === "",
            "a deck that does not exist resolves to no run");

        // ── The gate now bites for the deck an administrator actually picks ─
        const launchDeckDecision = await PaidDeckPublishGate.evaluate(
            await PaidDeckProvenanceLinkResolver.resolveForDeckId(launchDeckId));

        assert(launchDeckDecision.allowed === false,
            "publishing the launch deck is refused while the run's blocking flag is unresolved");
        assert(launchDeckDecision.blockingFlags.length === 1,
            "the refusal names the run's blocking flag");

        // ── End to end through the real publish path ──────────────────────
        const blockedResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: listingId,
                title: "Chemistry",
                isPublished: true,
                basePriceMinor: 1000,
                isPerpetual: true,
                sourceDeckId: launchDeckId,
                provenanceDeckId: launchDeckId
            },
            deckPayload: buildDeckPayload("Chemistry"),
            publisherUserId: ownerUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(blockedResult.success === false,
            "a real publish of the launch deck is refused — the gate is no longer inert for pipeline decks");

        // ── Resolve the flag, publish, and read the trail back ────────────
        await GenerationProvenanceQueryEngine.recordFlagResolution(mainTaskId,
        {
            flagIndex: 0,
            resolution: PaidDeckPublishGate.RESOLUTION_NOT_A_PROBLEM,
            note: "Reviewed.",
            actorUserId: ownerUserId
        });

        const allowedResult = await PaidDeckPublishService.publish
        ({
            metadata:
            {
                id: listingId,
                title: "Chemistry",
                isPublished: true,
                basePriceMinor: 1000,
                isPerpetual: true,
                sourceDeckId: launchDeckId,
                provenanceDeckId: launchDeckId
            },
            deckPayload: buildDeckPayload("Chemistry"),
            publisherUserId: ownerUserId,
            audienceOrganizationId: "",
            audienceTags: [],
            allowPricing: true
        });

        assert(allowedResult.success === true, "the same publish succeeds once the flag is resolved");

        const storedListing = await paidDecksCollection.findOne({ id: listingId });
        assert(storedListing?.provenanceDeckId === producedDeckId,
            "the stored link points at the deck the record names, not the deck that was picked");
        assert(storedListing?.sourceDeckId === launchDeckId,
            "the stored source deck still records which deck the content was taken from");

        // This is the call the audit-trail endpoint makes. It returning the
        // record's deck id is the difference between a PDF and a 404.
        const resolvedForAuditTrail = await PaidDeckProvenanceLinkResolver.resolveProvenanceDeckId(listingId);
        assert(resolvedForAuditTrail === producedDeckId,
            "the audit-trail lookup resolves the listing to its generation record");

        const auditTrailRecord = await GenerationProvenanceQueryEngine.findByDeckId(resolvedForAuditTrail);
        assert(auditTrailRecord !== null && auditTrailRecord.mainTaskId === mainTaskId,
            "the record reached from the listing is the one this run wrote");

        // The last hop, through the endpoint's own renderer. A resolved record
        // that cannot be rendered is still a failed download, and the renderer
        // lives in Common/ — a directory Dock does not deploy with, which is
        // exactly how it came to be missing from a running server.
        //
        // Rendered in the bare-record shape on purpose: the renderer must keep
        // accepting it so a server and a renderer that are briefly out of step
        // still produce a report.
        await renderProvenancePayload(auditTrailRecord, "a legacy single record renders to a real PDF through the endpoint's renderer");
    }
    finally
    {
        try
        {
            await decksCollection.deleteMany({ "data.id": { $in: createdDeckIds } });
            await paidDecksCollection.deleteMany({ id: listingId });
            await provenanceCollection.deleteMany({ mainTaskId: mainTaskId });
            await database.collection(DatabaseConstants.PAID_DECK_MASTER_ENTITIES_COLLECTION).deleteMany({ deckId: listingId });
            await database.collection(DatabaseConstants.PAID_DECK_ASSETS_COLLECTION).deleteMany({ deckId: listingId });
            await database.collection(DatabaseConstants.PAID_DECK_PRICINGS_COLLECTION).deleteMany({ deckId: listingId });
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`);
        }
    }
}


/**
 * Tier 4 — one deck, several generation runs.
 *
 * Generating into the same deck more than once is ordinary: a syllabus grows, a
 * unit is regenerated. Each run is a separate act with its own sources, models
 * and verification outcome, so the deck ends up with one record per run and ALL
 * of them govern it.
 *
 * The failure this tier exists to prevent is the quiet one: a reader that takes
 * the first record and calls it the deck's provenance. That reads as "this deck
 * was verified" while meaning "one of the runs that made it was verified", and
 * it would let a clean second run vouch for a first run nobody ever checked.
 */
async function runMultipleRunTier()
{
    section("Tier 4 — a deck generated into more than once");

    if (process.env.VERIFY_PAID_DECK_GATE_DB !== "1")
    {
        skip("Multi-run tier not requested — set VERIFY_PAID_DECK_GATE_DB=1 with Mongo running");
        return;
    }

    const database = await DatabaseConnector.getDatabase();
    if (!database)
    {
        skip("Multi-run tier — MongoDB is not reachable");
        return;
    }

    const provenanceCollection = database.collection(DatabaseConstants.GENERATION_PROVENANCE_COLLECTION);

    const uniqueSuffix = `${Date.now()}`;
    const ownerUserId = `${TEST_NAME_PREFIX}multi-owner-${uniqueSuffix}`;
    const sharedDeckId = `${TEST_NAME_PREFIX}multi-deck-${uniqueSuffix}`;
    const firstRunId = `${TEST_NAME_PREFIX}multi-run-one-${uniqueSuffix}`;
    const secondRunId = `${TEST_NAME_PREFIX}multi-run-two-${uniqueSuffix}`;

    try
    {
        // Run one: flagged. Run two: clean. Both into the same deck.
        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: firstRunId,
            deckId: sharedDeckId,
            deckName: "Chemistry",
            generatedByUserId: ownerUserId,
            producedDeckIds: [`${TEST_NAME_PREFIX}unit-one-${uniqueSuffix}`],
            sources: [{ name: "syllabus-part-one.pdf", contentHash: "hash-one", declaredSourceType: "CURRICULUM_OR_SYLLABUS" }],
            declaredSourceTypeNames: ["CURRICULUM_OR_SYLLABUS"],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [{ actionType: "GENERATION", modelIdentifier: "test-model-1", timestampUtcMilliseconds: Date.now() }],
            verification: { version: 1, verifiedEntityCount: 5, blockingFlagCount: 1, advisoryFlagCount: 0, flags: [buildBlockingFlag("Run one stated a wrong constant.")], summary: "1 blocking" },
            coverageReconciliation: null
        });

        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: secondRunId,
            deckId: sharedDeckId,
            deckName: "Chemistry",
            generatedByUserId: ownerUserId,
            producedDeckIds: [`${TEST_NAME_PREFIX}unit-two-${uniqueSuffix}`],
            sources: [{ name: "syllabus-part-two.pdf", contentHash: "hash-two", declaredSourceType: "CURRICULUM_OR_SYLLABUS" }],
            declaredSourceTypeNames: ["CURRICULUM_OR_SYLLABUS"],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [{ actionType: "GENERATION", modelIdentifier: "test-model-2", timestampUtcMilliseconds: Date.now() }],
            verification: { version: 1, verifiedEntityCount: 7, blockingFlagCount: 0, advisoryFlagCount: 0, flags: [], summary: "clean" },
            coverageReconciliation: null
        });

        const allRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(sharedDeckId);
        assert(allRecords.length === 2, "both runs are kept — neither overwrites the other");
        assert(allRecords[0].mainTaskId === firstRunId && allRecords[1].mainTaskId === secondRunId,
            "the runs come back oldest first, in the order the content was made");

        // The regression this tier guards: run two is clean, so a reader that
        // stopped at one record could report the deck as publishable.
        const blockedDecision = await PaidDeckPublishGate.evaluate(sharedDeckId);
        assert(blockedDecision.allowed === false, "a clean later run does not vouch for an earlier flagged one");
        assert(blockedDecision.blockingFlags.length === 1, "the refusal names the flag from the run that raised it");
        assert(blockedDecision.blockingFlags[0].mainTaskId === firstRunId, "the blocking flag says which run it belongs to");

        // Answering the WRONG run must not clear it. Before resolutions were
        // keyed on the run, this decision would have landed on whichever record
        // matched the deck first.
        await GenerationProvenanceQueryEngine.recordFlagResolution(secondRunId,
        {
            flagIndex: 0,
            resolution: PaidDeckPublishGate.RESOLUTION_FIXED,
            note: "Answered against the wrong run.",
            actorUserId: ownerUserId
        });

        const stillBlockedDecision = await PaidDeckPublishGate.evaluate(sharedDeckId);
        assert(stillBlockedDecision.allowed === false, "a resolution recorded against another run does not clear the flag");

        await GenerationProvenanceQueryEngine.recordFlagResolution(firstRunId,
        {
            flagIndex: 0,
            resolution: PaidDeckPublishGate.RESOLUTION_FIXED,
            note: "Corrected.",
            actorUserId: ownerUserId
        });

        const allowedDecision = await PaidDeckPublishGate.evaluate(sharedDeckId);
        assert(allowedDecision.allowed === true, "the deck publishes once every run's blocking flags are answered");

        // An unverified third run re-blocks the deck: the gate covers every run,
        // not just the ones that happen to carry flags.
        const thirdRunId = `${TEST_NAME_PREFIX}multi-run-three-${uniqueSuffix}`;
        await GenerationProvenanceQueryEngine.record
        ({
            mainTaskId: thirdRunId,
            deckId: sharedDeckId,
            deckName: "Chemistry",
            generatedByUserId: ownerUserId,
            producedDeckIds: [],
            sources: [],
            declaredSourceTypeNames: [],
            acceptedSourceTypeName: "CURRICULUM_OR_SYLLABUS",
            actions: [],
            verification: null,
            coverageReconciliation: null
        });

        const reblockedDecision = await PaidDeckPublishGate.evaluate(sharedDeckId);
        assert(reblockedDecision.allowed === false, "a later run whose verification never ran re-blocks the deck");
        assert((reblockedDecision.detail || "").includes("3"), "the refusal says how many runs produced the deck");

        await provenanceCollection.deleteOne({ mainTaskId: thirdRunId });

        // Publication stamps every run, because every run is part of what was
        // published.
        const stampedCount = await GenerationProvenanceQueryEngine.recordPublication(sharedDeckId, ownerUserId);
        assert(stampedCount === 2, "publishing stamps all of the deck's records, not just the first");

        // One report covering both runs. Larger than either run alone, because it
        // contains both plus the index that names them.
        const bothRecords = await GenerationProvenanceQueryEngine.findAllByDeckId(sharedDeckId);
        const singleRunPdfSize = await renderProvenancePayload(
            { deckId: sharedDeckId, deckName: "Chemistry", records: [bothRecords[0]] },
            "a one-run audit trail renders",
        );
        const bothRunsPdfSize = await renderProvenancePayload(
            { deckId: sharedDeckId, deckName: "Chemistry", records: bothRecords },
            "an audit trail covering both runs renders",
        );

        assert(singleRunPdfSize === 0 || bothRunsPdfSize > singleRunPdfSize,
            "the two-run report is bigger than the one-run report — both runs are in it, not just the first");
    }
    finally
    {
        try
        {
            await provenanceCollection.deleteMany({ deckId: sharedDeckId });
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup failed: ${cleanupError.message}`);
        }
    }
}


async function main()
{
    console.log("CogniumLearn — paid-deck publish gate verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();
    await runDeckTreeTier();
    await runMultipleRunTier();

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
