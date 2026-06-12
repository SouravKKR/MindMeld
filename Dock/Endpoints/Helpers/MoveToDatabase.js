const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const Persistence = require("../../Globals/Classes/Persistence");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const SyllabusFingerprintMatcher = require("./SyllabusFingerprintMatcher");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { buildSyllabusPositionIndex, sortFilesBySyllabusPosition } = require("./SyllabusUtils");
const GeneratedFileLoader = require("../../Globals/Classes/Generation/GeneratedFileLoader");
const DeckHierarchyBuilder = require("../../Globals/Classes/Generation/DeckHierarchyBuilder");
const GeneratedEntityUpserter = require("../../Globals/Classes/Generation/GeneratedEntityUpserter");
const MockTestAssembler = require("../../Globals/Classes/Generation/MockTestAssembler");

/**
 * Moves a completed generation task's staged output (flashcards, study
 * materials, mock tests) from the task folder into the user's synced
 * database, building the shared deck hierarchy first and cleaning up the
 * task folder afterwards.
 *
 * The heavy lifting lives in the cohesive single-responsibility classes
 * under Globals/Classes/Generation/ — this function is the orchestrator
 * that sequences them.
 */
async function moveToDatabase(userId, mainTaskId, deckId, taskDescriptor, flashcardGenerationSettings, studyMaterialGenerationSettings, mockTestGenerationSettings)
{
    const refreshedTask = await taskDescriptor;

    if (refreshedTask.getStatus() !== taskStatus.COMPLETED)
    {
        console.log(`[MoveToDatabase] Task ${mainTaskId} did not complete — skipping database move.`);
        return;
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

    const existingDeckIdByChainKey = await SyllabusFingerprintMatcher.findMergeTargetMap(userId, deckId, allTopicChains);
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
        await DeckHierarchyBuilder.mergeExistingDeckMetadata(userId, deckKeyToDataMap, reusedDeckIds);
    }

    // ── 4. Upsert cards ────────────────────────────────────────────────────────
    if (orderedFlashcardFiles.length > 0)
    {
        await GeneratedEntityUpserter.upsertCards(userId, orderedFlashcardFiles, resolveLeafDeckId, syllabusPositionIndex, now, reusedDeckIds);
        console.log(`[MoveToDatabase] Upserted cards for task ${mainTaskId}.`);
    }

    // ── 5. Upsert study materials using the shared hierarchy ───────────────────
    if (orderedStudyMaterialFiles.length > 0)
    {
        await GeneratedEntityUpserter.upsertStudyMaterials(userId, orderedStudyMaterialFiles, resolveLeafDeckId, syllabusPositionIndex, now);
        console.log(`[MoveToDatabase] Upserted study materials for task ${mainTaskId}.`);
    }

    // ── 6. Assemble and upsert mock tests ──────────────────────────────────────
    //       Default behaviour: mock tests live directly on deckId — one bundle on
    //       the deck where the user initiated generation. When the user enabled
    //       recursive mode (Blueprint.recursive === true), questions are bucketed
    //       across every deck in the generated subtree, so resolveLeafDeckId +
    //       deckKeyToDataMap are forwarded to allow per-deck distribution.
    if (mockTestGenerationSettings !== null)
    {
        await MockTestAssembler.upsertMockTests(userId, deckId, mainTaskId, now, mockTestGenerationSettings, resolveLeafDeckId, deckKeyToDataMap);
        console.log(`[MoveToDatabase] Upserted mock tests for task ${mainTaskId}.`);
    }

    // ── 7. Upsert all decks exactly once ───────────────────────────────────────
    let decksUpserted = 0;

    for (const deckData of deckKeyToDataMap.values())
    {
        await SyncQueryEngine.upsertDeck(userId, deckData);
        decksUpserted++;
    }

    if (decksUpserted > 0)
    {
        console.log(`[MoveToDatabase] Upserted ${decksUpserted} deck(s) for task ${mainTaskId}.`);
    }

    // ── 8. Read and print debug logs before deletion so they appear in Node.js console ──
    const taskFolderPrefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/`;
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
    await Promise.all(taskFiles.map(filePath => Persistence.delete(filePath)));

    console.log(`[MoveToDatabase] Deleted ${taskFiles.length} GCS file(s) for task ${mainTaskId}.`);
}

module.exports = { moveToDatabase };
