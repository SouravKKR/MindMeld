const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const Persistence = require("../../Globals/Classes/Persistence");
const SyllabusFingerprintMatcher = require("./SyllabusFingerprintMatcher");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { buildSyllabusPositionIndex, sortFilesBySyllabusPosition } = require("./SyllabusUtils");
const GeneratedFileLoader = require("../../Globals/Classes/Generation/GeneratedFileLoader");
const DeckHierarchyBuilder = require("../../Globals/Classes/Generation/DeckHierarchyBuilder");
const GeneratedEntityUpserter = require("../../Globals/Classes/Generation/GeneratedEntityUpserter");
const MockTestAssembler = require("../../Globals/Classes/Generation/MockTestAssembler");
const GenerationProvenance = require("../../Globals/Classes/Generation/GenerationProvenance");
const PaidDeckGenerationGate = require("../../Globals/Classes/Generation/PaidDeckGenerationGate");
const PaidDeckProvenanceAssembler = require("../../Globals/Classes/Generation/PaidDeckProvenanceAssembler");
const AiGeneratedTargetDeckStamper = require("../../Globals/Classes/Generation/AiGeneratedTargetDeckStamper");
const EphemeralUploadRegistry = require("../../Globals/Classes/Content/EphemeralUploadRegistry");
const GenerationStagingPolicy = require("../../Globals/Classes/Content/GenerationStagingPolicy");
const { aiGeneratedStampResults } = require("../../Globals/Enumerations/AiGeneratedStampResults");

/**
 * Moves a completed generation task's staged output (flashcards, study
 * materials, mock tests) from the task folder into the user's synced
 * database, building the shared deck hierarchy first and cleaning up the
 * task folder afterwards.
 *
 * The heavy lifting lives in the cohesive single-responsibility classes
 * under Globals/Classes/Generation/ — this function is the orchestrator
 * that sequences them.
 *
 * THREE IDENTIFIERS, and conflating any two of them breaks something:
 *
 *   persistenceScopeKey — the LIBRARY. Every per-user collection is keyed by
 *       it, and it is an opaque owner string to all of them: `<userId>` for a
 *       personal run, `<userId>::org:<organizationId>` for an organization one.
 *       This is what decides where the decks show up.
 *   personalUserId — the ACCOUNT that ran the generation. Provenance records it
 *       as generatedByUserId, and that value is later used as a task owner by
 *       SourceVerificationRunner, so it has to resolve to a real account. A
 *       scope key there would own tasks nobody can see.
 *   organizationId — attribution, "" when personal. Stamped on the deck so a
 *       reader does not have to parse a scope key to learn who a deck was made
 *       for, and recorded on provenance because the organization is the party
 *       answerable for its intellectual-property clearance.
 *
 * @param {string} persistenceScopeKey
 * @param {string} personalUserId
 * @param {string} organizationId
 */
async function moveToDatabase(persistenceScopeKey, mainTaskId, deckId, taskDescriptor, flashcardGenerationSettings, studyMaterialGenerationSettings, mockTestGenerationSettings, failureContext = null, bAllowRootMerge = false, generalGenerationSettings = null, personalUserId = null, organizationId = "")
{
    // Defaulted rather than required so the two call sites that pass a plain
    // personal id (and every test harness that does) keep working unchanged.
    const resolvedPersonalUserId = typeof personalUserId === "string" && personalUserId.length > 0
        ? personalUserId
        : persistenceScopeKey;
    const resolvedOrganizationId = typeof organizationId === "string" ? organizationId : "";
    // Provenance for complaint response: which uploaded documents fed this run.
    // Stamped onto every entity the run produces so "what did we generate from
    // this document" becomes an answerable question. See GenerationProvenance
    // for why this is an investigation aid and not a deletion trigger.
    const sourceContentHashes = GenerationProvenance.extractSourceContentHashes(generalGenerationSettings);

    const refreshedTask = await taskDescriptor;

    if (refreshedTask.getStatus() !== taskStatus.COMPLETED)
    {
        console.log(`[MoveToDatabase] Task ${mainTaskId} did not complete — skipping database move.`);
        return { partialCompletion: null, createdFlashcardCount: 0, createdStudyMaterialCount: 0 };
    }

    const now = new Date().toISOString();

    // ── 1. Load all generated files (images already injected by PrepareImages task) ──
    const flashcardFiles = flashcardGenerationSettings !== null
        ? await GeneratedFileLoader.loadFlashcardFiles(mainTaskId)
        : [];

    const studyMaterialFiles = studyMaterialGenerationSettings !== null
        ? await GeneratedFileLoader.loadStudyMaterialFiles(mainTaskId)
        : [];

    // ── 2. Load Syllabus.json and build a position index so every generated file
    //       can be ordered to match the original syllabus DFS traversal order.
    //       This drives both deck ordering (via buildHierarchy insertion order)
    //       and per-resource ordering (via syllabusPosition on cards/study materials).
    const syllabusJson = await GeneratedFileLoader.loadSyllabus(mainTaskId);
    const syllabusPositionIndex = syllabusJson ? buildSyllabusPositionIndex(syllabusJson) : null;

    const orderedFlashcardFiles = syllabusPositionIndex
        ? sortFilesBySyllabusPosition(flashcardFiles, syllabusPositionIndex)
        : flashcardFiles;

    const orderedStudyMaterialFiles = syllabusPositionIndex
        ? sortFilesBySyllabusPosition(studyMaterialFiles, syllabusPositionIndex)
        : studyMaterialFiles;

    // ── 3. Build ONE shared deck hierarchy across all topic chains ─────────────
    //       Files are processed in syllabus order so the subDecks arrays of every
    //       parent deck reflect the original syllabus sequence.
    //       Mock test chains are folded in so recursive mock test generation works
    //       even when no flashcards / study materials are being produced (the deck
    //       tree must exist before per-deck bucketing in upsertMockTests).
    // Only fold mock test chains into the shared hierarchy when recursive
    // mode is requested — otherwise non-recursive mock-test-only generation
    // would create empty subdecks (no cards / study materials attached) just
    // because buildHierarchy saw chains for them.
    const mockTestRecursiveActive = mockTestGenerationSettings !== null
        && typeof mockTestGenerationSettings.getRecursive === "function"
        && mockTestGenerationSettings.getRecursive() === true;

    const mockTestTopicChains = mockTestRecursiveActive
        ? await GeneratedFileLoader.loadMockTestTopicChains(mainTaskId)
        : [];

    const allTopicChains = [
        ...orderedFlashcardFiles.map(file => file.topicChain),
        ...orderedStudyMaterialFiles.map(file => file.topicChain),
        ...mockTestTopicChains,
    ];

    const beautifiedShortNamesByDeckKey = await GeneratedFileLoader.loadBeautifiedShortNames(mainTaskId);

    const existingDeckIdByChainKey = await SyllabusFingerprintMatcher.findMergeTargetMap(persistenceScopeKey, deckId, allTopicChains, bAllowRootMerge);
    if (existingDeckIdByChainKey)
    {
        console.log(`[MoveToDatabase] Merging into existing deck subtree under ${deckId}: ${existingDeckIdByChainKey.size} reusable deck path(s).`);
    }

    let deckKeyToDataMap = new Map();
    let resolveLeafDeckId = () => null;
    let reusedDeckIds = new Set();

    if (allTopicChains.length > 0)
    {
        ({ deckKeyToDataMap, resolveLeafDeckId, reusedDeckIds } = DeckHierarchyBuilder.buildHierarchy(allTopicChains, deckId, now, syllabusPositionIndex, beautifiedShortNamesByDeckKey, existingDeckIdByChainKey));
    }

    if (reusedDeckIds.size > 0)
    {
        await DeckHierarchyBuilder.mergeExistingDeckMetadata(persistenceScopeKey, deckKeyToDataMap, reusedDeckIds);
    }

    // ── 4. Upsert cards ────────────────────────────────────────────────────────
    if (orderedFlashcardFiles.length > 0)
    {
        await GeneratedEntityUpserter.upsertCards(persistenceScopeKey, orderedFlashcardFiles, resolveLeafDeckId, syllabusPositionIndex, now, reusedDeckIds, sourceContentHashes);
        console.log(`[MoveToDatabase] Upserted cards for task ${mainTaskId}.`);
    }

    // ── 5. Upsert study materials using the shared hierarchy ───────────────────
    if (orderedStudyMaterialFiles.length > 0)
    {
        await GeneratedEntityUpserter.upsertStudyMaterials(persistenceScopeKey, orderedStudyMaterialFiles, resolveLeafDeckId, syllabusPositionIndex, now, sourceContentHashes);
        console.log(`[MoveToDatabase] Upserted study materials for task ${mainTaskId}.`);
    }

    // ── 6. Assemble and upsert mock tests ──────────────────────────────────────
    //       Default behaviour: mock tests live directly on deckId — one bundle on
    //       the deck where the user initiated generation. When the user enabled
    //       recursive mode (Blueprint.recursive === true), questions are bucketed
    //       across every deck in the generated subtree, so resolveLeafDeckId +
    //       deckKeyToDataMap are forwarded to allow per-deck distribution.
    let upsertedMockTestCount = 0;
    if (mockTestGenerationSettings !== null)
    {
        upsertedMockTestCount = await MockTestAssembler.upsertMockTests(persistenceScopeKey, deckId, mainTaskId, now, mockTestGenerationSettings, resolveLeafDeckId, deckKeyToDataMap) || 0;

        // Only claim an upsert when one happened. This used to print
        // unconditionally, so a run that had just logged "Blueprint.json not
        // found — mock test assembly skipped" immediately followed it with
        // "Upserted mock tests", which is the opposite of what occurred.
        if (upsertedMockTestCount > 0)
        {
            console.log(`[MoveToDatabase] Upserted ${upsertedMockTestCount} mock test(s) for task ${mainTaskId}.`);
        }
    }

    // ── 7. Upsert all decks exactly once ───────────────────────────────────────
    // When a sibling output type failed mid-run we keep what the survivors
    // produced (above) and stamp a partialCompletion marker on the top-level
    // decks (those whose parent IS the deck the user generated into) so the UI
    // can offer "kept N, retry the rest" instead of a bare "Failed". On a fully
    // successful run (failureContext === null) we clear any stale marker that a
    // prior partial run left on a now-reused deck.
    const createdFlashcardCount = orderedFlashcardFiles.reduce((runningTotal, flashcardFile) => runningTotal + (Array.isArray(flashcardFile.cards) ? flashcardFile.cards.length : 0), 0);
    const createdStudyMaterialCount = orderedStudyMaterialFiles.length;
    const createdMockTests = (failureContext !== null) && Array.isArray(failureContext.completedScopes) && failureContext.completedScopes.includes("mockTestGeneration");

    const bSomethingKept = createdFlashcardCount > 0 || createdStudyMaterialCount > 0 || createdMockTests;

    // Top-level decks (direct children of the deck the user generated into) are
    // the ones that carry the badge and that a retry must clear on success —
    // recorded into the marker so the retry can clear them by id even when it
    // produces no deck rows of its own (e.g. a mock-tests-only retry).
    const topLevelDeckIds = [];
    for (const deckData of deckKeyToDataMap.values())
    {
        if (deckData.parent === deckId)
        {
            topLevelDeckIds.push(deckData.id);
        }
    }

    let partialCompletion = null;
    if (failureContext !== null && bSomethingKept)
    {
        partialCompletion =
        {
            mainTaskId: failureContext.mainTaskId,
            generatedAt: now,
            createdFlashcardCount: createdFlashcardCount,
            createdStudyMaterialCount: createdStudyMaterialCount,
            createdMockTests: createdMockTests,
            completedScopes: failureContext.completedScopes,
            failedScopes: failureContext.failedScopes,
            retryBody: { ...failureContext.retryBody, clearPartialCompletionDeckIds: topLevelDeckIds },
        };
    }

    // A paid-deck run marks the decks it produced so the admin panel can find
    // them and so the publish gate can locate their provenance record. The
    // decks themselves are ordinary synced decks — they become sellable only
    // when an administrator uploads them through /Admin/PaidDecks/Upload, and
    // the gate refuses to publish one whose verification is unresolved.
    const bPaidDeckMode = PaidDeckGenerationGate.isRequested(generalGenerationSettings);

    let decksUpserted = 0;

    for (const deckData of deckKeyToDataMap.values())
    {
        // Every deck the run produced, not only the top-level ones. The marker is
        // how PaidDeckGenerationRunLocator maps the deck an administrator chose to
        // sell back to the run that made it, and the deck they choose is often a
        // sub-deck sold on its own — which, when only top-level decks carried the
        // marker, could not be matched to its own audit trail.
        if (bPaidDeckMode)
        {
            deckData.additionalData =
            {
                ...(deckData.additionalData || {}),
                paidDeckGeneration: { mainTaskId: mainTaskId, generatedAt: now },
            };
        }

        // Attribution, written alongside the scope rather than instead of it.
        // The scope key already says which library the deck lives in, but it
        // says so in a format every reader would have to parse; and a deck can
        // be moved. This records which organization the run was made FOR at the
        // moment it was made, which is the fact the terms of service make that
        // organization answerable for.
        if (resolvedOrganizationId.length > 0)
        {
            deckData.additionalData =
            {
                ...(deckData.additionalData || {}),
                organizationId: resolvedOrganizationId,
            };
        }

        if (deckData.parent === deckId)
        {
            if (partialCompletion !== null)
            {
                deckData.additionalData = { ...(deckData.additionalData || {}), partialCompletion: partialCompletion };
            }
            else if (failureContext === null && deckData.additionalData && deckData.additionalData.partialCompletion)
            {
                const clearedAdditionalData = { ...deckData.additionalData };
                delete clearedAdditionalData.partialCompletion;
                deckData.additionalData = clearedAdditionalData;
            }
        }

        await SyncQueryEngine.upsertDeck(persistenceScopeKey, deckData);
        decksUpserted++;
    }

    if (decksUpserted > 0)
    {
        console.log(`[MoveToDatabase] Upserted ${decksUpserted} deck(s) for task ${mainTaskId}.`);
    }

    // ── 7.5 Mark the deck the user launched generation from ────────────────────
    // Everything this run CREATED was marked by DeckHierarchyBuilder, but the
    // launch deck already existed and is not in deckKeyToDataMap, so nothing
    // marked it. It is the tile the user actually looks at on the home grid, and
    // in non-recursive mode it is where the whole mock-test bundle lands — so
    // leaving it unmarked left a deck holding generated content with its Export
    // button intact and no owner watermark.
    //
    // Gated on what this run actually persisted, NOT on bSomethingKept: that
    // flag's mock-test term is only ever true when failureContext is non-null,
    // so a fully successful mock-tests-only run would slip through unmarked —
    // precisely the case this is here to cover.
    if (decksUpserted > 0 || upsertedMockTestCount > 0)
    {
        const stampResult = await AiGeneratedTargetDeckStamper.markGenerationTargetDeck(persistenceScopeKey, deckId);

        if (stampResult === aiGeneratedStampResults.DECK_NOT_FOUND)
        {
            // The launch deck has not reached the server yet (created offline,
            // generation started before the first sync). Everything this run
            // created is still marked, so containsAiGeneratedContent() continues
            // to block a recursive export of it.
            console.warn(`[MoveToDatabase] Generation target deck ${deckId} not found server-side — AI-generated marker not applied.`);
        }
        else if (stampResult === aiGeneratedStampResults.MARKED)
        {
            console.log(`[MoveToDatabase] Marked generation target deck ${deckId} as AI-generated.`);
        }
    }

    // ── Paid-deck provenance: assemble BEFORE the task folder is deleted ──────
    // The action trail, verification report and coverage reconciliation all live
    // in the task folder that step 9 wipes. This is the last moment the run's
    // own record still exists AND the deck id it belongs to is known, so it is
    // where the two are bound together and committed.
    //
    // One record per RUN, filed against the deck the run was launched INTO —
    // the deck the user right-clicked, and the deck an administrator later
    // uploads as a paid deck.
    //
    // Not the decks the run created. Those are its output ("Unit I: ...",
    // "Unit II: ..."), and filing there put the record on a node nobody sells:
    // a listing for the launch deck found nothing, the audit trail 404'd, and
    // the publish gate — which treats "no record" as "nothing to verify" —
    // allowed the publish. Filing it against the deck that is actually sold
    // makes the subject of the evidence the subject of the sale, and makes the
    // report name the deck on the listing rather than one of its children.
    //
    // A deck can accumulate SEVERAL records, one per run, when generation is run
    // into it more than once. That is correct and they are all kept: each run is
    // separate evidence about a separate act, and nothing here overwrites or
    // merges them. Every reader — the gate, the review dialog, the audit trail —
    // takes all of a deck's records together.
    //
    // Best-effort — a failure here leaves the deck intact but unpublishable,
    // which is the correct direction to fail in (the publish gate refuses a deck
    // with no provenance record).
    if (bPaidDeckMode && topLevelDeckIds.length > 0)
    {
        // The root deck's id is the literal "0" for EVERY user, so a record filed
        // against it would collide across accounts. A run launched from the home
        // grid falls back to what it produced, which is at least unique.
        const bLaunchedFromRoot = deckId === AiGeneratedTargetDeckStamper.ROOT_DECK_ID;
        const provenanceSubjectDeckId = bLaunchedFromRoot ? topLevelDeckIds[0] : deckId;

        const launchDeckData = bLaunchedFromRoot ? null : await SyncQueryEngine.getDeck(persistenceScopeKey, deckId);
        const producedDeckData = Array.from(deckKeyToDataMap.values()).find(deckData => deckData.id === provenanceSubjectDeckId);

        await PaidDeckProvenanceAssembler.assembleAndRecord(
        {
            mainTaskId: mainTaskId,
            deckId: provenanceSubjectDeckId,
            deckName: (launchDeckData ? launchDeckData.name : null) || (producedDeckData ? producedDeckData.name : null),

            // The ACCOUNT, deliberately not the scope key. This lands in the
            // record as generatedByUserId, and SourceVerificationRunner later
            // passes that value straight into a TaskDescriptor as its owner — a
            // scope key there would create tasks owned by a namespace instead of
            // a person, which nothing tracking a user's tasks would ever find.
            userId: resolvedPersonalUserId,

            organizationId: resolvedOrganizationId,
            producedDeckIds: topLevelDeckIds,
            generalGenerationSettings: generalGenerationSettings,
        });
    }

    // ── 8. Read and print debug logs before deletion so they appear in Node.js console ──
    const taskFolderPrefix = GenerationStagingPolicy.buildStoragePrefix(mainTaskId);
    const taskFiles = await Persistence.list(taskFolderPrefix);

    for (const filePath of taskFiles)
    {
        if (filePath.endsWith("GenerateMockTests.log") || (filePath.includes("/Worker_") && filePath.endsWith(".log")))
        {
            try
            {
                const logBuffer = await Persistence.read(filePath);
                console.log(`[Agent Log: ${filePath}]\n${logBuffer.toString("utf-8")}`);
            }
            catch (error) { /* ignore */ }
        }
    }

    // ── 9. Delete the entire task folder from GCS ─────────────────────────────
    // Routed through the registry rather than deleting the listing directly, so
    // the deletion record Generate.js wrote at run start is cleared in the same
    // step. Deleting the objects while leaving the row behind would leave the
    // reaper re-listing an empty prefix on every tick, forever.
    const removedFileCount = await EphemeralUploadRegistry.purgePrefix(taskFolderPrefix);

    console.log(`[MoveToDatabase] Deleted ${removedFileCount} GCS file(s) for task ${mainTaskId}.`);

    return { partialCompletion: partialCompletion, createdFlashcardCount: createdFlashcardCount, createdStudyMaterialCount: createdStudyMaterialCount };
}

module.exports = { moveToDatabase };
