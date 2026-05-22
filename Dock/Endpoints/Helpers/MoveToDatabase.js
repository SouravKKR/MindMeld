const { getRandomUuid } = require("../../Globals/UtilityFunctions.js/GetRandomUuid");
const SyncQueryEngine = require("../../Globals/Classes/Database/SyncQueryEngine");
const Persistence = require("../../Globals/Classes/Persistence");
const PersistenceConstants = require("../../Globals/Constants/PersistenceConstants");
const DatabaseConnector = require("../../Globals/Classes/Database/DatabaseConnector");
const DatabaseConstants = require("../../Globals/Constants/DatabaseConstants");
const SyllabusFingerprintMatcher = require("./SyllabusFingerprintMatcher");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const { buildSyllabusPositionIndex, sortFilesBySyllabusPosition } = require("./SyllabusUtils");

const BEAUTIFIED_SHORT_NAMES_FILE_NAME = "BeautifiedShortNames.json";
const MAX_SHORT_NAME_LENGTH = 16;

/**
 * Derives a short name from a full deck name.
 * - Single word  → first 3 characters  (e.g. "Mitochondria" → "Mit")
 * - Multi-word   → first letter of each word, capitalised, max 6 chars
 *                  (e.g. "Cell Biology" → "CB", "The Nervous System" → "TNS")
 */
function generateShortName(name)
{
    const words = name.trim().split(/\s+/).filter(w => w.length > 0);

    if (words.length === 0)
    {
        return name.substring(0, 6);
    }

    if (words.length === 1)
    {
        return words[0].substring(0, 3);
    }

    return words.map(w => w[0].toUpperCase()).join("").substring(0, 6);
}

/**
 * Builds a shared deck hierarchy map from an array of topicChain arrays.
 * Returns a Map from deckKey → deck data object, with all parent → child
 * subDecks arrays wired up and leaf deck IDs resolved per topicChain.
 *
 * @param {string[][]} topicChains
 * @param {string} deckId
 * @param {string} now  ISO timestamp
 * @returns {{ deckKeyToDataMap: Map, resolveLeafDeckId: (topicChain: string[]) => string }}
 */
function buildDeckHierarchy(topicChains, deckId, now, syllabusPositionIndex, beautifiedShortNamesByDeckKey = null, existingDeckIdByChainKey = null)
{
    const deckKeyToDataMap = new Map();
    const reusedDeckIds = new Set();
    let nextSequencePosition = 0;

    const normalizeChainKey = (chainNames) =>
    {
        return chainNames
            .map(name => (typeof name === "string" ? name : "").trim().toLowerCase().replace(/\s+/g, " "))
            .join(" > ");
    };

    for (const topicChain of topicChains)
    {
        let currentParentDeckId = deckId;

        for (let chainIndex = 0; chainIndex < topicChain.length; chainIndex++)
        {
            const deckName = topicChain[chainIndex];
            const deckKey = topicChain.slice(0, chainIndex + 1).join(" > ");

            if (!deckKeyToDataMap.has(deckKey))
            {
                // Position derived from the first time this deck-key appears.
                // For leaf decks: their own syllabus position; for intermediates:
                // the position of the first descendant leaf seen (since topicChains
                // are pre-sorted by syllabusPosition, this is the minimum).
                let resolvedSyllabusPosition = nextSequencePosition;
                if (syllabusPositionIndex)
                {
                    const fullChainKey = topicChain.join(" > ");
                    const leafPosition = syllabusPositionIndex.get(fullChainKey);
                    if (typeof leafPosition === "number")
                    {
                        resolvedSyllabusPosition = leafPosition;
                    }
                }
                nextSequencePosition++;

                const beautifiedShortName = beautifiedShortNamesByDeckKey?.get(deckKey);
                const resolvedShortName = (typeof beautifiedShortName === "string" && beautifiedShortName.length > 0)
                    ? beautifiedShortName.substring(0, MAX_SHORT_NAME_LENGTH)
                    : generateShortName(deckName);

                const normalizedKey = normalizeChainKey(topicChain.slice(0, chainIndex + 1));
                const reusableExistingDeckId = existingDeckIdByChainKey?.get(normalizedKey);
                const resolvedDeckId = (typeof reusableExistingDeckId === "string" && reusableExistingDeckId.length > 0)
                    ? reusableExistingDeckId
                    : getRandomUuid();

                if (typeof reusableExistingDeckId === "string" && reusableExistingDeckId.length > 0)
                {
                    reusedDeckIds.add(reusableExistingDeckId);
                }

                deckKeyToDataMap.set(deckKey,
                {
                    id: resolvedDeckId,
                    name: deckName,
                    shortName: resolvedShortName,
                    tags: [],
                    parent: currentParentDeckId,
                    subDecks: [],
                    cards: [],
                    studyMaterials: [],
                    additionalData: { protected: true, syllabusPosition: resolvedSyllabusPosition },
                    lifecycle:
                    {
                        creationDate: now,
                        lastModified: now,
                        views: 0,
                        attempts: 0,
                        timeSpentInSeconds: 0
                    }
                });
            }

            currentParentDeckId = deckKeyToDataMap.get(deckKey).id;
        }

        // ── Wire up parent → child subDecks arrays ─────────────────────────────
        for (let chainIndex = 1; chainIndex < topicChain.length; chainIndex++)
        {
            const parentKey = topicChain.slice(0, chainIndex).join(" > ");
            const childKey  = topicChain.slice(0, chainIndex + 1).join(" > ");

            const parentDeckData = deckKeyToDataMap.get(parentKey);
            const childDeckId    = deckKeyToDataMap.get(childKey)?.id;

            if (parentDeckData && childDeckId && !parentDeckData.subDecks.includes(childDeckId))
            {
                parentDeckData.subDecks.push(childDeckId);
            }
        }
    }

    const resolveLeafDeckId = (topicChain) =>
    {
        return deckKeyToDataMap.get(topicChain.join(" > "))?.id ?? null;
    };

    return { deckKeyToDataMap, resolveLeafDeckId, reusedDeckIds };
}

// ── File loaders ───────────────────────────────────────────────────────────────

async function loadFlashcardFiles(mainTaskId)
{
    const prefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.FLASHCARDS_DIRECTORY}/`;
    const filePaths = await Persistence.list(prefix);

    const files = [];

    for (const filePath of filePaths)
    {
        const buffer = await Persistence.read(filePath);
        const file = JSON.parse(buffer.toString("utf-8"));

        if (!Array.isArray(file.topicChain) || file.topicChain.length === 0 || !Array.isArray(file.cards))
        {
            console.log(`[MoveToDatabase] Skipping malformed flashcard file: ${filePath}`);
            continue;
        }

        files.push(file);
    }

    return files;
}

async function loadStudyMaterialFiles(mainTaskId)
{
    const prefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.STUDY_MATERIALS_DIRECTORY}/`;
    const filePaths = await Persistence.list(prefix);

    const files = [];

    for (const filePath of filePaths)
    {
        const buffer = await Persistence.read(filePath);
        const file = JSON.parse(buffer.toString("utf-8"));

        if (!file.topicChain || !file.content)
        {
            continue;
        }

        files.push(file);
    }

    return files;
}

async function loadSyllabus(mainTaskId)
{
    const syllabusPath = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.SYLLABUS_FILE_NAME}`;

    try
    {
        const buffer = await Persistence.read(syllabusPath);
        return JSON.parse(buffer.toString("utf-8"));
    }
    catch (e)
    {
        console.warn(`[MoveToDatabase] Syllabus.json not found for task ${mainTaskId} — syllabus ordering will not be applied.`);
        return null;
    }
}

/**
 * When the merge path reuses existing deck ids, the freshly-built deck data
 * has only the new generation's subDecks and a freshly-stamped lifecycle.
 * Without intervention SyncQueryEngine.upsertDeck's `$set` would overwrite
 * the existing row's subDecks (dropping unrelated siblings) and additionalData
 * (clobbering auto-analysis state, syllabusEmbedding caches, etc.). This
 * helper queries each reused deck and unions the existing subDecks + carries
 * forward analysis-relevant additionalData fields onto the new deck object.
 */
async function mergeExistingDeckMetadata(userId, deckKeyToDataMap, reusedDeckIds)
{
    if (!(reusedDeckIds instanceof Set) || reusedDeckIds.size === 0)
    {
        return;
    }

    const deckCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.DECKS_COLLECTION);

    const dataByDeckId = new Map();
    for (const deckData of deckKeyToDataMap.values())
    {
        dataByDeckId.set(deckData.id, deckData);
    }

    const existingDecks = await deckCollection.find(
        { userId: userId, id: { $in: Array.from(reusedDeckIds) } },
        { projection: { _id: 0 } },
    ).toArray();

    for (const existingDeck of existingDecks)
    {
        const newDeckData = dataByDeckId.get(existingDeck.id);
        if (!newDeckData)
        {
            continue;
        }

        const existingSubDeckIds = Array.isArray(existingDeck.subDecks) ? existingDeck.subDecks : [];
        const mergedSubDeckSet = new Set(newDeckData.subDecks || []);
        for (const existingSubDeckId of existingSubDeckIds)
        {
            mergedSubDeckSet.add(existingSubDeckId);
        }
        newDeckData.subDecks = Array.from(mergedSubDeckSet);

        const existingAdditionalData = existingDeck.additionalData || {};
        newDeckData.additionalData =
        {
            ...existingAdditionalData,
            ...newDeckData.additionalData,
        };

        if (existingDeck.lifecycle?.creationDate)
        {
            newDeckData.lifecycle =
            {
                ...newDeckData.lifecycle,
                creationDate: existingDeck.lifecycle.creationDate,
            };
        }
    }
}

async function loadBeautifiedShortNames(mainTaskId)
{
    const beautifiedPath = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${BEAUTIFIED_SHORT_NAMES_FILE_NAME}`;

    try
    {
        const buffer = await Persistence.read(beautifiedPath);
        const parsedDocument = JSON.parse(buffer.toString("utf-8"));

        if (!parsedDocument || typeof parsedDocument !== "object")
        {
            return null;
        }

        const beautifiedMap = new Map();
        for (const [deckKey, candidateShortName] of Object.entries(parsedDocument))
        {
            if (typeof candidateShortName === "string" && candidateShortName.length > 0)
            {
                beautifiedMap.set(deckKey, candidateShortName);
            }
        }

        return beautifiedMap.size > 0 ? beautifiedMap : null;
    }
    catch (beautifiedReadError)
    {
        return null;
    }
}

// ── Entity upserts ─────────────────────────────────────────────────────────────

async function upsertCards(userId, flashcardFiles, resolveLeafDeckId, syllabusPositionIndex, now, reusedDeckIds = null)
{
    const cardCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.CARDS_COLLECTION);

    const normalizedExistingQuestionsByDeckId = new Map();
    const reusedDeckIdSet = (reusedDeckIds instanceof Set) ? reusedDeckIds : new Set();

    for (const flashcardFile of flashcardFiles)
    {
        const leafDeckId       = resolveLeafDeckId(flashcardFile.topicChain);
        const syllabusPosition = syllabusPositionIndex?.get(flashcardFile.topicChain.join(" > ")) ?? 0;

        if (reusedDeckIdSet.has(leafDeckId) && !normalizedExistingQuestionsByDeckId.has(leafDeckId))
        {
            const existingCards = await cardCollection.find(
                { userId: userId, deckId: leafDeckId },
                { projection: { _id: 0, question: 1 } },
            ).toArray();

            const normalizedSet = new Set(existingCards.map(existingCard => normalizeQuestionText(existingCard.question)));
            normalizedExistingQuestionsByDeckId.set(leafDeckId, normalizedSet);
        }

        const existingNormalized = normalizedExistingQuestionsByDeckId.get(leafDeckId) || new Set();

        for (const card of flashcardFile.cards)
        {
            const normalizedQuestion = normalizeQuestionText(card.question);
            if (existingNormalized.has(normalizedQuestion))
            {
                continue;
            }
            existingNormalized.add(normalizedQuestion);

            const cardData =
            {
                id: getRandomUuid(),
                question: card.question,
                answer: card.answer,
                tags: [],
                deckId: leafDeckId,
                baseDifficulty: 1500,
                additionalData: { ...(card.additionalData ?? {}), syllabusPosition },
                lifecycle:
                {
                    creationDate: now,
                    lastModified: now,
                    views: 0,
                    attempts: 0,
                    timeSpentInSeconds: 0
                },
                progress:
                {
                    progressPoints: []
                }
            };

            await SyncQueryEngine.upsertCard(userId, cardData);
        }
    }
}

function normalizeQuestionText(rawQuestion)
{
    if (typeof rawQuestion !== "string")
    {
        return "";
    }
    return rawQuestion.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

async function upsertStudyMaterials(userId, studyMaterialFiles, resolveLeafDeckId, syllabusPositionIndex, now)
{
    const STANDARD_DETAIL_LEVEL = 1;

    for (const file of studyMaterialFiles)
    {
        const deckId           = resolveLeafDeckId(file.topicChain);
        const syllabusPosition = syllabusPositionIndex?.get(file.topicChain.join(" > ")) ?? 0;
        const detailLevel      = (typeof file.detailLevel === "number") ? file.detailLevel : STANDARD_DETAIL_LEVEL;

        const studyMaterialData =
        {
            id: getRandomUuid(),
            content: file.content,
            deckId: deckId,
            syllabusPosition,
            detailLevel,
            lifecycle:
            {
                creationDate: now,
                lastModified: now,
                views: 0,
                attempts: 0,
                timeSpentInSeconds: 0
            }
        };

        await SyncQueryEngine.upsertStudyMaterial(userId, studyMaterialData);
    }
}

/**
 * Extracts the marking-scheme blob from the mock-test generation settings.
 * Returns a fully-resolved scheme — missing fields are filled from defaults
 * so MockTest.fromJson sees a stable shape regardless of caller payload.
 */
function extractMarkingScheme(mockTestGenerationSettings)
{
    const settings = mockTestGenerationSettings || {};

    const correctMarks = typeof settings.correctMarks === "number" ? settings.correctMarks : 4;
    const wrongMarks = typeof settings.wrongMarks === "number" ? settings.wrongMarks : -1;
    const unattemptedMarks = typeof settings.unattemptedMarks === "number" ? settings.unattemptedMarks : 0;
    const partialMarks = typeof settings.partialMarks === "number" ? settings.partialMarks : 0;

    const perTypeMarkingOverrides = settings.perTypeMarkingOverrides && typeof settings.perTypeMarkingOverrides === "object"
        ? settings.perTypeMarkingOverrides
        : {};

    const sectionStructure = Array.isArray(settings.sectionStructure)
        ? settings.sectionStructure
        : [];

    return {
        correctMarks,
        wrongMarks,
        unattemptedMarks,
        partialMarks,
        perTypeMarkingOverrides,
        // The persisted MockTest still calls this array `perSectionMarkingOverrides`
        // (its hand-written model is unchanged). The live settings field is the
        // renamed `sectionStructure` — entries now carry questionCount + totalMarks
        // alongside the marking-rule fields. Pass through verbatim; older readers
        // that only consume the marking-rule keys are unaffected by the extra
        // properties.
        perSectionMarkingOverrides: sectionStructure
    };
}

/**
 * Finds the per-section override whose `questionTypes` filter matches the
 * given question-type integer value. The override entry stores QuestionTypes
 * enum names; we translate the typeValue to its name via `typeDisplayKeys`
 * (an injected name→intValue map) and check membership. Returns null when
 * no section override applies.
 */
function findSectionOverrideForType(perSectionMarkingOverrides, typeValue, typeKeyByValue)
{
    if (!Array.isArray(perSectionMarkingOverrides) || perSectionMarkingOverrides.length === 0)
    {
        return null;
    }

    const typeKey = typeKeyByValue[typeValue];
    if (!typeKey)
    {
        return null;
    }

    for (const entry of perSectionMarkingOverrides)
    {
        if (!entry || !Array.isArray(entry.questionTypes))
        {
            continue;
        }
        if (entry.questionTypes.includes(typeKey))
        {
            return entry;
        }
    }

    return null;
}

/**
 * Resolves a section entry's question count for assembly. For FIXED-mode
 * entries this just returns `questionCount`. For RANGE-mode entries it
 * samples a value from [questionCountMin, questionCountMax] using
 * `questionCountWeights` (missing values default to weight 1). If a payload
 * is malformed (e.g. RANGE flag set but min/max missing), falls back to the
 * midpoint so assembly never crashes.
 */
function resolveSectionQuestionCount(sectionEntry)
{
    const RANGE_MODE = 1;

    if (sectionEntry?.questionCountMode === RANGE_MODE)
    {
        const minimumCount = Number.isFinite(sectionEntry.questionCountMin) && sectionEntry.questionCountMin >= 0
            ? sectionEntry.questionCountMin
            : 0;
        const maximumCount = Number.isFinite(sectionEntry.questionCountMax) && sectionEntry.questionCountMax >= minimumCount
            ? sectionEntry.questionCountMax
            : minimumCount;

        if (maximumCount <= 0)
        {
            return Number.isFinite(sectionEntry.questionCount) && sectionEntry.questionCount > 0
                ? sectionEntry.questionCount
                : Math.round((minimumCount + maximumCount) / 2);
        }

        const configuredWeights = sectionEntry.questionCountWeights || {};

        const candidateValues = [];
        const samplingWeights = [];
        let totalWeight = 0;
        for (let candidateValue = minimumCount; candidateValue <= maximumCount; candidateValue++)
        {
            const rawWeight = configuredWeights[String(candidateValue)];
            const candidateWeight = (typeof rawWeight === "number" && Number.isFinite(rawWeight) && rawWeight >= 0)
                ? rawWeight
                : 1;
            candidateValues.push(candidateValue);
            samplingWeights.push(candidateWeight);
            totalWeight += candidateWeight;
        }

        if (totalWeight <= 0)
        {
            return Math.round((minimumCount + maximumCount) / 2);
        }

        let rollingThreshold = Math.random() * totalWeight;
        for (let candidateIndex = 0; candidateIndex < candidateValues.length; candidateIndex++)
        {
            rollingThreshold -= samplingWeights[candidateIndex];
            if (rollingThreshold <= 0)
            {
                return candidateValues[candidateIndex];
            }
        }

        return candidateValues[candidateValues.length - 1];
    }

    return typeof sectionEntry?.questionCount === "number" && sectionEntry.questionCount > 0
        ? sectionEntry.questionCount
        : 0;
}

/**
 * Walks the configured sectionStructure in order, claiming questions from the
 * pool that match each section's `questionTypes` filter (or any type if the
 * filter is empty). Each section item is emitted with its configured
 * marking-rule override bound by `sectionItemId` so the scoring engine can
 * resolve section → rule in O(1). Any questions that no section claimed land
 * in a trailing "Unassigned" section so nothing is silently dropped.
 *
 * The order of sections in the persisted MockTest matches the order in
 * sectionStructure — that's the contract the user sees on the editor.
 */
function assembleSectionsFromStructure(items, testQuestions, configuredSections, typeKeyByValue, typeDisplayNames)
{
    const remainingQuestions = [...testQuestions];

    for (let configuredIndex = 0; configuredIndex < configuredSections.length; configuredIndex++)
    {
        const configuredEntry = configuredSections[configuredIndex];
        const allowedTypeKeys = Array.isArray(configuredEntry.questionTypes) ? configuredEntry.questionTypes : [];

        const resolvedQuestionCount = resolveSectionQuestionCount(configuredEntry);
        // Stamp the realized count back onto the entry so the persisted
        // MockTest's per-section override reflects what was actually used
        // (instead of the range spec, which would be misleading at scoring time).
        configuredEntry.questionCount = resolvedQuestionCount;

        const claimedQuestions = [];
        const desiredCount = resolvedQuestionCount > 0
            ? resolvedQuestionCount
            : remainingQuestions.length;

        for (let candidateIndex = 0; candidateIndex < remainingQuestions.length && claimedQuestions.length < desiredCount; candidateIndex++)
        {
            const candidate = remainingQuestions[candidateIndex];
            const candidateTypeValue = candidate.additionalData?.type ?? -1;
            const candidateTypeKey = typeKeyByValue[candidateTypeValue];

            const matchesFilter = allowedTypeKeys.length === 0 || (candidateTypeKey && allowedTypeKeys.includes(candidateTypeKey));
            if (matchesFilter)
            {
                claimedQuestions.push(candidate);
                remainingQuestions.splice(candidateIndex, 1);
                candidateIndex--;
            }
        }

        // Even if the section ended up empty (no matching questions
        // survived), still emit the header so the user can see the
        // configured structure on the persisted mock test.
        const sectionMarks = claimedQuestions.reduce((sum, question) => sum + (question.marks ?? 0), 0);
        const sectionTitle = configuredEntry.name && configuredEntry.name.trim().length > 0
            ? configuredEntry.name
            : `Section ${configuredIndex + 1}`;

        const sectionItem = {
            id: getRandomUuid(),
            type: 0,
            title: sectionTitle,
            description: `${claimedQuestions.length} question(s) · ${sectionMarks} marks`
        };

        const hasMarkingFieldOverride =
            typeof configuredEntry.correctMarks === "number" ||
            typeof configuredEntry.wrongMarks === "number" ||
            typeof configuredEntry.unattemptedMarks === "number" ||
            typeof configuredEntry.partialMarks === "number";

        if (hasMarkingFieldOverride)
        {
            sectionItem.markingSchemeOverride = {
                correctMarks: typeof configuredEntry.correctMarks === "number" ? configuredEntry.correctMarks : null,
                wrongMarks: typeof configuredEntry.wrongMarks === "number" ? configuredEntry.wrongMarks : null,
                unattemptedMarks: typeof configuredEntry.unattemptedMarks === "number" ? configuredEntry.unattemptedMarks : null,
                partialMarks: typeof configuredEntry.partialMarks === "number" ? configuredEntry.partialMarks : null
            };

            // Bind this concrete section's UUID into the parent entry so
            // the scoring engine can match by sectionItemId instead of by
            // name (faster + collision-proof when two sections share a name).
            configuredEntry.sectionItemId = sectionItem.id;
        }

        items.push(sectionItem);

        for (const generatedQuestion of claimedQuestions)
        {
            items.push(buildQuestionItem(generatedQuestion));
        }
    }

    if (remainingQuestions.length > 0)
    {
        const fallbackSection = {
            id: getRandomUuid(),
            type: 0,
            title: "Unassigned",
            description: `${remainingQuestions.length} question(s) · ${remainingQuestions.reduce((sum, question) => sum + (question.marks ?? 0), 0)} marks`
        };
        items.push(fallbackSection);
        for (const generatedQuestion of remainingQuestions)
        {
            items.push(buildQuestionItem(generatedQuestion));
        }
    }
}

/**
 * Fallback section assembly used when sectionStructure is empty. Groups the
 * generated pool by QuestionTypes integer value and emits one section per
 * non-empty type. Single-type papers (a pure-MCQ paper, for example) skip
 * the section header — the questions list reads as one homogeneous block.
 */
function assembleSectionsByTypeGrouping(items, testQuestions, typeDisplayNames)
{
    const byType = new Map();
    for (const question of testQuestions)
    {
        const typeValue = question.additionalData?.type ?? -1;
        if (!byType.has(typeValue))
        {
            byType.set(typeValue, []);
        }
        byType.get(typeValue).push(question);
    }

    const sectionLabels = ["A", "B", "C", "D", "E", "F", "G"];
    const hasMultipleTypes = byType.size > 1;
    let sectionIndex = 0;

    for (const [typeValue, typeQuestions] of byType.entries())
    {
        if (hasMultipleTypes)
        {
            const sectionLabel = sectionLabels[sectionIndex] ?? String(sectionIndex + 1);
            const typeName = typeDisplayNames[typeValue] ?? "Questions";
            const sectionMarks = typeQuestions.reduce((sum, question) => sum + (question.marks ?? 0), 0);

            items.push({
                id: getRandomUuid(),
                type: 0,
                title: `Section ${sectionLabel} — ${typeName}`,
                description: `${typeQuestions.length} question(s) · ${sectionMarks} marks`
            });

            sectionIndex++;
        }

        for (const generatedQuestion of typeQuestions)
        {
            items.push(buildQuestionItem(generatedQuestion));
        }
    }
}

function buildQuestionItem(generatedQuestion)
{
    return {
        id: getRandomUuid(),
        type: 3,
        question: generatedQuestion.question,
        answer: "",
        expectedAnswer: generatedQuestion.expectedAnswer,
        answerReason: generatedQuestion.answerReason,
        solvingSteps: generatedQuestion.solvingSteps || "",
        marks: generatedQuestion.marks,
        score: 0,
        additionalData: generatedQuestion.additionalData
    };
}

async function upsertMockTests(userId, deckId, mainTaskId, now, mockTestGenerationSettings = null)
{
    // Load Blueprint.json written by GenerateMockTests.py — contains exam metadata,
    // numberOfTests, totalQuestions, questionsRepeatChance, instructions, duration.
    let blueprint;
    try
    {
        const blueprintBuffer = await Persistence.read(
            `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.BLUEPRINT_FILE_NAME}`
        );
        blueprint = JSON.parse(blueprintBuffer.toString("utf-8"));
    }
    catch (e)
    {
        console.error(`[MoveToDatabase] Blueprint.json not found for task ${mainTaskId} — mock test assembly skipped. This usually means the GENERATE_MOCK_TESTS workflow did not complete successfully.`);
        return;
    }

    // Collect all questions from every MockTestQuestions file into a flat pool
    const questionPrefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.MOCK_TEST_QUESTIONS_DIRECTORY}/`;
    const questionFilePaths = await Persistence.list(questionPrefix);

    const allQuestions = [];
    for (const filePath of questionFilePaths)
    {
        try
        {
            const buf  = await Persistence.read(filePath);
            const file = JSON.parse(buf.toString("utf-8"));
            if (Array.isArray(file.questions)) allQuestions.push(...file.questions);
        }
        catch (e)
        {
            console.log(`[MoveToDatabase] Skipping malformed question file: ${filePath}`);
        }
    }

    if (allQuestions.length === 0)
    {
        console.log(`[MoveToDatabase] No mock test questions found — skipping assembly.`);
        return;
    }

    const { numberOfTests, totalQuestions, questionsRepeatChance, examName, subjectName, instructions, duration } = blueprint;

    // ── Marking scheme: frozen at generation time so scoring is stable even
    //    if the template is later edited. Each SECTION item gets its own
    //    `markingSchemeOverride` when a per-section rule matches the section's
    //    question type, so the rule travels with the question grouping.
    const markingScheme = extractMarkingScheme(mockTestGenerationSettings);

    const { questionTypes: questionTypesEnum } = require("../../Globals/Enumerations/QuestionTypes");
    const typeKeyByValue = {};
    for (const [typeKey, typeValue] of Object.entries(questionTypesEnum))
    {
        typeKeyByValue[typeValue] = typeKey;
    }

    // Shuffle the full pool once
    const pool = [...allQuestions].sort(() => Math.random() - 0.5);

    // freshPerSubsequent = questions drawn fresh from the pool for each test after the first.
    // The rest of each subsequent test is filled from questions already used in prior tests.
    const freshPerSubsequent = Math.round(totalQuestions * (1 - questionsRepeatChance));

    let   freshCursor = 0;
    const repeatPool  = [];

    for (let testIndex = 0; testIndex < numberOfTests; testIndex++)
    {
        const testQuestions = [];

        if (testIndex === 0)
        {
            const slice = pool.slice(freshCursor, freshCursor + totalQuestions);
            testQuestions.push(...slice);
            repeatPool.push(...slice);
            freshCursor += slice.length;
        }
        else
        {
            const freshSlice = pool.slice(freshCursor, freshCursor + freshPerSubsequent);
            testQuestions.push(...freshSlice);
            repeatPool.push(...freshSlice);
            freshCursor += freshSlice.length;

            const needed = totalQuestions - testQuestions.length;
            if (needed > 0)
            {
                const shuffledRepeat = [...repeatPool].sort(() => Math.random() - 0.5);
                testQuestions.push(...shuffledRepeat.slice(0, needed));
            }
        }

        // Shuffle the final question order within this test
        testQuestions.sort(() => Math.random() - 0.5);

        // ── Build items[] ──────────────────────────────────────────────────────
        // mockTestItemTypes: SECTION=0, INSTRUCTIONS=1, TITLE=2, QUESTION=3
        const title = examName
            ? `${examName} — ${subjectName} Mock Test ${testIndex + 1}`
            : `${subjectName} Practice Test ${testIndex + 1}`;

        const items = [];

        items.push({ id: getRandomUuid(), type: 2, title });

        if (instructions && instructions.trim().length > 0)
        {
            items.push({ id: getRandomUuid(), type: 1, content: instructions });
        }

        const typeDisplayNames = { 0: "Multiple Choice", 1: "Multiple Correct Answers", 2: "Single Word / Phrase", 3: "Short Answer", 4: "Medium Answer", 5: "Long Answer", 6: "Essay" };
        const configuredSections = Array.isArray(markingScheme.perSectionMarkingOverrides)
            ? markingScheme.perSectionMarkingOverrides
            : [];

        if (configuredSections.length > 0)
        {
            assembleSectionsFromStructure(items, testQuestions, configuredSections, typeKeyByValue, typeDisplayNames);
        }
        else
        {
            assembleSectionsByTypeGrouping(items, testQuestions, typeDisplayNames);
        }

        const mockTestData =
        {
            id: getRandomUuid(),
            deckId: deckId,
            title,
            duration, // 0 for unknown exams — user configures before starting the test
            items,
            history: [],
            lifecycle:
            {
                creationDate: now,
                lastModified: now,
                views: 0,
                attempts: 0,
                timeSpentInSeconds: 0
            },
            markingScheme: markingScheme
        };

        await SyncQueryEngine.upsertMockTest(userId, mockTestData);
    }
}

// ── Main entry point ───────────────────────────────────────────────────────────

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
        ? await loadFlashcardFiles(mainTaskId)
        : [];

    const studyMaterialFiles = studyMaterialGenerationSettings !== null
        ? await loadStudyMaterialFiles(mainTaskId)
        : [];

    // ── 2. Load Syllabus.json and build a position index so every generated file
    //       can be ordered to match the original syllabus DFS traversal order.
    //       This drives both deck ordering (via buildDeckHierarchy insertion order)
    //       and per-resource ordering (via syllabusPosition on cards/study materials).
    const syllabusJson           = await loadSyllabus(mainTaskId);
    const syllabusPositionIndex  = syllabusJson ? buildSyllabusPositionIndex(syllabusJson) : null;

    const orderedFlashcardFiles      = syllabusPositionIndex
        ? sortFilesBySyllabusPosition(flashcardFiles, syllabusPositionIndex)
        : flashcardFiles;

    const orderedStudyMaterialFiles  = syllabusPositionIndex
        ? sortFilesBySyllabusPosition(studyMaterialFiles, syllabusPositionIndex)
        : studyMaterialFiles;

    // ── 3. Build ONE shared deck hierarchy across all topic chains ─────────────
    //       Files are processed in syllabus order so the subDecks arrays of every
    //       parent deck reflect the original syllabus sequence.
    const allTopicChains = [
        ...orderedFlashcardFiles.map(f => f.topicChain),
        ...orderedStudyMaterialFiles.map(f => f.topicChain),
    ];

    const beautifiedShortNamesByDeckKey = await loadBeautifiedShortNames(mainTaskId);

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
        ({ deckKeyToDataMap, resolveLeafDeckId, reusedDeckIds } = buildDeckHierarchy(allTopicChains, deckId, now, syllabusPositionIndex, beautifiedShortNamesByDeckKey, existingDeckIdByChainKey));
    }

    if (reusedDeckIds.size > 0)
    {
        await mergeExistingDeckMetadata(userId, deckKeyToDataMap, reusedDeckIds);
    }

    // ── 4. Upsert cards ────────────────────────────────────────────────────────
    if (orderedFlashcardFiles.length > 0)
    {
        await upsertCards(userId, orderedFlashcardFiles, resolveLeafDeckId, syllabusPositionIndex, now, reusedDeckIds);
        console.log(`[MoveToDatabase] Upserted cards for task ${mainTaskId}.`);
    }

    // ── 5. Upsert study materials using the shared hierarchy ───────────────────
    if (orderedStudyMaterialFiles.length > 0)
    {
        await upsertStudyMaterials(userId, orderedStudyMaterialFiles, resolveLeafDeckId, syllabusPositionIndex, now);
        console.log(`[MoveToDatabase] Upserted study materials for task ${mainTaskId}.`);
    }

    // ── 6. Assemble and upsert mock tests ──────────────────────────────────────
    //       Mock tests live directly on deckId — they are a single entity on the
    //       deck where the user initiated generation, not distributed across sub-decks.
    if (mockTestGenerationSettings !== null)
    {
        await upsertMockTests(userId, deckId, mainTaskId, now, mockTestGenerationSettings);
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
            catch (e) { /* ignore */ }
        }
    }

    // ── 8. Delete the entire task folder from GCS ─────────────────────────────
    await Promise.all(taskFiles.map(filePath => Persistence.delete(filePath)));

    console.log(`[MoveToDatabase] Deleted ${taskFiles.length} GCS file(s) for task ${mainTaskId}.`);
}

module.exports = { moveToDatabase };