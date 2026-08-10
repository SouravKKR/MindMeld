const { getRandomUuid } = require("../../UtilityFunctions.js/GetRandomUuid");
const SyncQueryEngine = require("../Database/SyncQueryEngine");
const Persistence = require("../Persistence");
const PersistenceConstants = require("../../Constants/PersistenceConstants");
const MarkingSchemeExtractor = require("./MarkingSchemeExtractor");
const MockTestSectionGeometry = require("./MockTestSectionGeometry");
const { questionTypes } = require("../../Enumerations/QuestionTypes");
const { sectionQuestionCountModes } = require("../../Enumerations/SectionQuestionCountModes");
const { sectionMarksModes } = require("../../Enumerations/SectionMarksModes");

/**
 * Turns the generated mock-test question pool into persisted MockTest
 * documents. Handles section assembly (either from the user's configured
 * sectionStructure or a fallback type-grouping), per-test question sampling
 * with repeat handling, and recursive per-deck bucketing of questions across
 * the generated subtree.
 */
class MockTestAssembler
{
    /**
     * Resolves a section entry's question count for assembly. For FIXED-mode
     * entries this just returns `questionCount`. For RANGE-mode entries it
     * samples a value from [questionCountMin, questionCountMax] using
     * `questionCountWeights` (missing values default to weight 1). If a payload
     * is malformed (e.g. RANGE flag set but min/max missing), falls back to the
     * midpoint so assembly never crashes.
     *
     * Marks-driven sections never come through here — their count is not a
     * number to sample but an outcome of filling a marks budget, which is
     * #claimQuestionsForMarksBudget's job.
     */
    static #resolveSectionQuestionCount(sectionEntry)
    {
        if (sectionEntry?.questionCountMode === sectionQuestionCountModes.RANGE)
        {
            const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
            const minimumCount = countBand.minimum;
            const maximumCount = countBand.maximum;

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
     * True when this candidate question is one the section is allowed to hold.
     * An empty type filter means "any type", which is what an unconfigured
     * section list has always meant.
     */
    static #matchesSectionTypeFilter(candidateQuestion, allowedTypeKeys, typeKeyByValue)
    {
        if (allowedTypeKeys.length === 0)
        {
            return true;
        }

        const candidateTypeValue = candidateQuestion.additionalData?.type ?? -1;
        const candidateTypeKey = typeKeyByValue[candidateTypeValue];

        return Boolean(candidateTypeKey) && allowedTypeKeys.includes(candidateTypeKey);
    }

    /**
     * Fills a marks-driven section: take questions until their marks add up to
     * the section's budget, rather than until a question count is reached.
     *
     * This is the half of "each question is worth 4-10 marks and some number of
     * them sum to 20" that cannot be done by counting. The Agent generates
     * questions whose marks fall inside the section's band, and this picks the
     * subset that lands on the total.
     *
     * The selection is greedy-largest-fit: at each step take the biggest
     * question that still fits in what is left. That reaches the budget exactly
     * whenever the pool allows it and gets closest when it does not, without the
     * cost of searching every subset — and it naturally front-loads the heavier
     * questions, which is how a real paper of mixed-weight questions reads.
     *
     * Claimed questions are spliced out of `remainingQuestions`, matching the
     * count-driven path so a later section cannot claim the same question twice.
     */
    static #claimQuestionsForMarksBudget(remainingQuestions, sectionEntry, allowedTypeKeys, typeKeyByValue)
    {
        const countBand = MockTestSectionGeometry.resolveQuestionCountBand(sectionEntry);
        const totalMarksBudget = MockTestSectionGeometry.resolveTotalMarksBudget(sectionEntry);

        const claimedQuestions = [];

        if (totalMarksBudget <= 0 || countBand.maximum <= 0)
        {
            return claimedQuestions;
        }

        let remainingBudget = totalMarksBudget;

        while (claimedQuestions.length < countBand.maximum && remainingBudget > MockTestSectionGeometry.FLOATING_POINT_TOLERANCE)
        {
            let bestFittingIndex = -1;
            let bestFittingMarks = -1;
            let smallestOverflowIndex = -1;
            let smallestOverflowMarks = Number.POSITIVE_INFINITY;

            for (let candidateIndex = 0; candidateIndex < remainingQuestions.length; candidateIndex++)
            {
                const candidateQuestion = remainingQuestions[candidateIndex];
                if (!MockTestAssembler.#matchesSectionTypeFilter(candidateQuestion, allowedTypeKeys, typeKeyByValue))
                {
                    continue;
                }

                const candidateMarks = Number.isFinite(candidateQuestion.marks) && candidateQuestion.marks > 0
                    ? candidateQuestion.marks
                    : 0;

                if (candidateMarks <= 0)
                {
                    continue;
                }

                if (candidateMarks <= remainingBudget + MockTestSectionGeometry.FLOATING_POINT_TOLERANCE)
                {
                    if (candidateMarks > bestFittingMarks)
                    {
                        bestFittingMarks = candidateMarks;
                        bestFittingIndex = candidateIndex;
                    }
                }
                else if (candidateMarks < smallestOverflowMarks)
                {
                    smallestOverflowMarks = candidateMarks;
                    smallestOverflowIndex = candidateIndex;
                }
            }

            // Nothing fits the remaining budget. Below the section's minimum
            // count, a slight overshoot is the better failure: a section that is
            // one question short of what its own configuration promised reads as
            // a generation fault, while a couple of marks over reads as rounding.
            let chosenIndex = bestFittingIndex;
            if (chosenIndex === -1)
            {
                if (claimedQuestions.length >= countBand.minimum || smallestOverflowIndex === -1)
                {
                    break;
                }
                chosenIndex = smallestOverflowIndex;
            }

            const chosenQuestion = remainingQuestions[chosenIndex];
            remainingQuestions.splice(chosenIndex, 1);
            claimedQuestions.push(chosenQuestion);
            remainingBudget -= chosenQuestion.marks;
        }

        return claimedQuestions;
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
    static #assembleSectionsFromStructure(items, testQuestions, configuredSections, typeKeyByValue, typeDisplayNames)
    {
        const remainingQuestions = [...testQuestions];

        for (let configuredIndex = 0; configuredIndex < configuredSections.length; configuredIndex++)
        {
            const configuredEntry = configuredSections[configuredIndex];
            const allowedTypeKeys = Array.isArray(configuredEntry.questionTypes) ? configuredEntry.questionTypes : [];

            let claimedQuestions = [];

            if (MockTestSectionGeometry.resolveMarksMode(configuredEntry) === sectionMarksModes.RANGE_PER_QUESTION)
            {
                // The section states a marks budget, not a question count, so
                // how many questions it ends up with is whatever adds up.
                claimedQuestions = MockTestAssembler.#claimQuestionsForMarksBudget(
                    remainingQuestions,
                    configuredEntry,
                    allowedTypeKeys,
                    typeKeyByValue
                );
            }
            else
            {
                const resolvedQuestionCount = MockTestAssembler.#resolveSectionQuestionCount(configuredEntry);
                const desiredCount = resolvedQuestionCount > 0
                    ? resolvedQuestionCount
                    : remainingQuestions.length;

                for (let candidateIndex = 0; candidateIndex < remainingQuestions.length && claimedQuestions.length < desiredCount; candidateIndex++)
                {
                    const candidate = remainingQuestions[candidateIndex];

                    if (MockTestAssembler.#matchesSectionTypeFilter(candidate, allowedTypeKeys, typeKeyByValue))
                    {
                        claimedQuestions.push(candidate);
                        remainingQuestions.splice(candidateIndex, 1);
                        candidateIndex--;
                    }
                }
            }

            // Stamp the realized count back onto the entry so the persisted
            // MockTest's per-section override reflects what was actually used
            // (instead of the range spec, which would be misleading at scoring time).
            configuredEntry.questionCount = claimedQuestions.length;

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
                items.push(MockTestAssembler.#buildQuestionItem(generatedQuestion));
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
                items.push(MockTestAssembler.#buildQuestionItem(generatedQuestion));
            }
        }
    }

    /**
     * Fallback section assembly used when sectionStructure is empty. Groups the
     * generated pool by QuestionTypes integer value and emits one section per
     * non-empty type. Single-type papers (a pure-MCQ paper, for example) skip
     * the section header — the questions list reads as one homogeneous block.
     */
    static #assembleSectionsByTypeGrouping(items, testQuestions, typeDisplayNames)
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
                items.push(MockTestAssembler.#buildQuestionItem(generatedQuestion));
            }
        }
    }

    static #buildQuestionItem(generatedQuestion)
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

    static async #assembleAndUpsertTestsForDeck(userId, targetDeckId, questionsForDeck, blueprint, markingScheme, typeKeyByValue, now, mockTestGenerationSettings = null)
    {
        if (!Array.isArray(questionsForDeck) || questionsForDeck.length === 0)
        {
            console.log(`[MoveToDatabase] No questions bucketed for deck ${targetDeckId} — skipping.`);
            return 0;
        }

        const { numberOfTests, totalQuestions, questionsRepeatChance, examName, subjectName, instructions, duration } = blueprint;

        // Resolve the title's base form. The user can type a title in the
        // generation page (settings.mockTestName); when blank we fall back
        // to the historical auto-formatted string so legacy flows still
        // produce a meaningful title.
        const userSuppliedTitle = (mockTestGenerationSettings && typeof mockTestGenerationSettings.getMockTestName === "function")
            ? (mockTestGenerationSettings.getMockTestName() || "").trim()
            : "";

        const baseTitle = userSuppliedTitle.length > 0
            ? userSuppliedTitle
            : (examName ? `${examName} — ${subjectName} Mock Test` : `${subjectName} Practice Test`);

        const pool = [...questionsForDeck].sort(() => Math.random() - 0.5);

        // freshPerSubsequent = questions drawn fresh from the pool for each test after the first.
        // The rest of each subsequent test is filled from questions already used in prior tests.
        const freshPerSubsequent = Math.round(totalQuestions * (1 - questionsRepeatChance));

        let freshCursor = 0;
        const repeatPool = [];

        let testsUpserted = 0;

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
            // Suffix is per-deck — tests in different decks share testIndex but
            // live under different deckIds, so cross-deck collisions don't matter.
            const title = `${baseTitle} ${testIndex + 1}`;

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
                MockTestAssembler.#assembleSectionsFromStructure(items, testQuestions, configuredSections, typeKeyByValue, typeDisplayNames);
            }
            else
            {
                MockTestAssembler.#assembleSectionsByTypeGrouping(items, testQuestions, typeDisplayNames);
            }

            const mockTestData =
            {
                id: getRandomUuid(),
                deckId: targetDeckId,
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
            testsUpserted++;
        }

        return testsUpserted;
    }

    /**
     * Assembles and upserts every mock test this run produced.
     *
     * @returns {Promise<number>} how many mock tests were upserted. The caller
     *          needs a truthful count to know whether generated content landed
     *          on the launch deck: in non-recursive mode every test is written
     *          straight onto deckId and no deck rows are created at all, so the
     *          deck-upsert count alone cannot tell that anything was generated.
     */
    static async upsertMockTests(userId, deckId, mainTaskId, now, mockTestGenerationSettings = null, resolveLeafDeckId = null, deckKeyToDataMap = null)
    {
        // Load Blueprint.json written by GenerateMockTests.py — contains exam metadata,
        // numberOfTests, totalQuestions, questionsRepeatChance, instructions, duration,
        // plus the recursive / skipRootDeck flags that drive per-deck bucketing.
        let blueprint;
        try
        {
            const blueprintBuffer = await Persistence.read(
                `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.BLUEPRINT_FILE_NAME}`
            );
            blueprint = JSON.parse(blueprintBuffer.toString("utf-8"));
        }
        catch (error)
        {
            console.error(`[MoveToDatabase] Blueprint.json not found for task ${mainTaskId} — mock test assembly skipped. This usually means the GENERATE_MOCK_TESTS workflow did not complete successfully.`);
            return 0;
        }

        // Collect every question, but keep its source topicChain so recursive
        // bucketing can route it to each ancestor deck in the generated tree.
        const questionPrefix = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}/${PersistenceConstants.MOCK_TEST_QUESTIONS_DIRECTORY}/`;
        const questionFilePaths = await Persistence.list(questionPrefix);

        const allQuestions = [];
        for (const filePath of questionFilePaths)
        {
            try
            {
                const buffer = await Persistence.read(filePath);
                const file = JSON.parse(buffer.toString("utf-8"));
                if (!Array.isArray(file.questions))
                {
                    continue;
                }
                const topicChain = Array.isArray(file.topicChain) ? file.topicChain : [];
                for (const question of file.questions)
                {
                    allQuestions.push({ ...question, topicChain });
                }
            }
            catch (error)
            {
                console.log(`[MoveToDatabase] Skipping malformed question file: ${filePath}`);
            }
        }

        if (allQuestions.length === 0)
        {
            console.log(`[MoveToDatabase] No mock test questions found — skipping assembly.`);
            return 0;
        }

        // ── Marking scheme: frozen at generation time so scoring is stable even
        //    if the template is later edited. Each SECTION item gets its own
        //    `markingSchemeOverride` when a per-section rule matches the section's
        //    question type, so the rule travels with the question grouping.
        const markingScheme = MarkingSchemeExtractor.extractMarkingScheme(mockTestGenerationSettings);

        const typeKeyByValue = {};
        for (const [typeKey, typeValue] of Object.entries(questionTypes))
        {
            typeKeyByValue[typeValue] = typeKey;
        }

        const recursive = blueprint.recursive === true;
        const skipRootDeck = blueprint.skipRootDeck === true;

        if (!recursive)
        {
            return await MockTestAssembler.#assembleAndUpsertTestsForDeck(userId, deckId, allQuestions, blueprint, markingScheme, typeKeyByValue, now, mockTestGenerationSettings);
        }

        // ── Recursive: bucket questions across every deck in the generated subtree ─
        if (typeof resolveLeafDeckId !== "function" || !(deckKeyToDataMap instanceof Map))
        {
            console.warn(`[MoveToDatabase] Recursive mock test mode requested but deck hierarchy was not provided — falling back to single-deck bundle on ${deckId}.`);
            return await MockTestAssembler.#assembleAndUpsertTestsForDeck(userId, deckId, allQuestions, blueprint, markingScheme, typeKeyByValue, now, mockTestGenerationSettings);
        }

        // Index decks by id so we can walk leaf → root via the `parent` link
        const deckDataById = new Map();
        for (const deckData of deckKeyToDataMap.values())
        {
            deckDataById.set(deckData.id, deckData);
        }

        const bucketsByDeckId = new Map();
        if (!skipRootDeck)
        {
            bucketsByDeckId.set(deckId, []);
        }

        let unroutedCount = 0;

        for (const question of allQuestions)
        {
            const topicChain = question.topicChain;
            if (!Array.isArray(topicChain) || topicChain.length === 0)
            {
                unroutedCount++;
                continue;
            }

            const leafDeckId = resolveLeafDeckId(topicChain);
            if (!leafDeckId)
            {
                unroutedCount++;
                continue;
            }

            let cursorDeckId = leafDeckId;
            while (cursorDeckId && cursorDeckId !== deckId)
            {
                if (!bucketsByDeckId.has(cursorDeckId))
                {
                    bucketsByDeckId.set(cursorDeckId, []);
                }
                bucketsByDeckId.get(cursorDeckId).push(question);

                const cursorDeckData = deckDataById.get(cursorDeckId);
                cursorDeckId = cursorDeckData ? cursorDeckData.parent : null;
            }

            if (!skipRootDeck)
            {
                bucketsByDeckId.get(deckId).push(question);
            }
        }

        if (unroutedCount > 0)
        {
            console.warn(`[MoveToDatabase] ${unroutedCount} mock-test question(s) had no resolvable topicChain — dropped from recursive distribution.`);
        }

        let totalTestsUpserted = 0;
        for (const [targetDeckId, bucket] of bucketsByDeckId.entries())
        {
            const upserted = await MockTestAssembler.#assembleAndUpsertTestsForDeck(userId, targetDeckId, bucket, blueprint, markingScheme, typeKeyByValue, now, mockTestGenerationSettings);
            totalTestsUpserted += upserted;
        }

        console.log(`[MoveToDatabase] Recursive mock tests: upserted ${totalTestsUpserted} test(s) across ${bucketsByDeckId.size} deck(s) (skipRootDeck=${skipRootDeck}).`);

        return totalTestsUpserted;
    }
}

module.exports = MockTestAssembler;
