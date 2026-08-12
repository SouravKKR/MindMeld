/**
 * End-to-end verification harness for mock-test section structure: the marks
 * modes, the derived question-count band, the validation that blocks an
 * impossible configuration, and the assembly that has to realise a section's
 * marks budget out of the generated pool.
 *
 * Run from the Dock directory:
 *     node VerifyMockTestSectionStructure.mjs
 *     VERIFY_MOCK_TEST_SECTIONS_DB=1 node VerifyMockTestSectionStructure.mjs
 *
 *   1. ALWAYS — pure checks of the geometry a section is built on: which of
 *      {count, marks per question, section total} is derived in each mode, the
 *      feasible count band for a marks budget, the legacy entries that predate
 *      marks modes, the paper-total reconciliation, the server-side refusal,
 *      and that every seeded template still describes a workable paper. No
 *      network, no database.
 *
 *   2. DB (opt-in: VERIFY_MOCK_TEST_SECTIONS_DB=1) — drives the real
 *      MockTestAssembler against Mongo and the storage layer with a fixture
 *      question pool: a marks-driven section claims questions until its budget
 *      is met rather than until a count is reached, a uniform section still
 *      takes exactly its configured count, question types are respected, and
 *      nothing is claimed twice. Everything it creates is prefixed and removed.
 */

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";

const require = createRequire(import.meta.url);
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

require("dotenv").config({ path: path.join(currentDirectory, ".env") });

const MockTestSectionGeometry = require("./Globals/Classes/Generation/MockTestSectionGeometry");
const MockTestAssembler = require("./Globals/Classes/Generation/MockTestAssembler");
const MockTestGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/MockTestGenerationSettings");
const Persistence = require("./Globals/Classes/Persistence");
const PersistenceConstants = require("./Globals/Constants/PersistenceConstants");
const DatabaseConstants = require("./Globals/Constants/DatabaseConstants");
const DatabaseConnector = require("./Globals/Classes/Database/DatabaseConnector");
const { validateGenerationSettings } = require("./Endpoints/Helpers/ValidateGenerationSettings");
const GeneralGenerationSettings = require("./Globals/Classes/Task/AutoGeneration/GeneralGenerationSettings");
const generationTemplates = require("./SeedData/GenerationTemplates.json");
const { sectionQuestionCountModes } = require("./Globals/Enumerations/SectionQuestionCountModes");
const { sectionMarksModes } = require("./Globals/Enumerations/SectionMarksModes");
const { automationLevels } = require("./Globals/Enumerations/AutomationLevels");
const { questionTypes } = require("./Globals/Enumerations/QuestionTypes");

const TEST_TASK_PREFIX = "verify-sections-";
const TEST_USER_ID = "verify-sections-user";

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


function buildUniformSection(overrides)
{
    return Object.assign(
    {
        name: "Section A",
        questionTypes: ["MULTIPLE_CHOICE"],
        questionCountMode: sectionQuestionCountModes.FIXED,
        questionCount: 20,
        marksMode: sectionMarksModes.UNIFORM_PER_QUESTION,
        marksPerQuestion: 4,
        totalMarks: 80
    }, overrides || {});
}

function buildMarksRangeSection(overrides)
{
    return Object.assign(
    {
        name: "Unit III",
        questionTypes: ["MEDIUM_SUBJECTIVE"],
        marksMode: sectionMarksModes.RANGE_PER_QUESTION,
        marksPerQuestionMin: 4,
        marksPerQuestionMax: 10,
        totalMarks: 20
    }, overrides || {});
}


async function runAlwaysOnTier()
{
    section("Tier 1 — section geometry, validation and the seeded templates");

    // ── The engineering case the whole feature exists for ─────────────────
    const engineeringSection = buildMarksRangeSection();
    const engineeringBand = MockTestSectionGeometry.resolveQuestionCountBand(engineeringSection);

    assert(engineeringBand.minimum === 2, "20 marks of 4-10 mark questions needs at least 2 questions");
    assert(engineeringBand.maximum === 5, "20 marks of 4-10 mark questions allows at most 5 questions");
    assert(MockTestSectionGeometry.isQuestionCountDerived(engineeringSection), "A marks-range section derives its question count");
    assert(MockTestSectionGeometry.describeValidationFailure(engineeringSection, "Section 1") === null, "The 4-10 marks / 20 total section is valid");

    const exactTotalBand = MockTestSectionGeometry.resolveTotalMarksBand(engineeringSection, 0);
    assert(exactTotalBand.minimum === 20 && exactTotalBand.maximum === 20, "A marks-range section's total is the budget, exactly");

    // ── Exact division must not be lost to floating point ─────────────────
    const evenlyDivisibleSection = buildMarksRangeSection({ marksPerQuestionMin: 4, marksPerQuestionMax: 4, totalMarks: 20 });
    const evenlyDivisibleBand = MockTestSectionGeometry.resolveQuestionCountBand(evenlyDivisibleSection);
    assert(evenlyDivisibleBand.minimum === 5 && evenlyDivisibleBand.maximum === 5, "20 marks of exactly-4-mark questions is exactly 5 questions, not 4 or 6");

    const fractionalSection = buildMarksRangeSection({ marksPerQuestionMin: 2.5, marksPerQuestionMax: 2.5, totalMarks: 7.5 });
    const fractionalBand = MockTestSectionGeometry.resolveQuestionCountBand(fractionalSection);
    assert(fractionalBand.minimum === 3 && fractionalBand.maximum === 3, "Fractional marks divide exactly (7.5 / 2.5 = 3), not 2");

    // ── Impossible budgets are refused, with a reason ─────────────────────
    const impossibleSection = buildMarksRangeSection({ marksPerQuestionMin: 7, marksPerQuestionMax: 9, totalMarks: 20 });
    const impossibleBand = MockTestSectionGeometry.resolveQuestionCountBand(impossibleSection);
    const impossibleFailure = MockTestSectionGeometry.describeValidationFailure(impossibleSection, "Section 1");

    assert(impossibleBand.minimum === 0 && impossibleBand.maximum === 0, "20 marks cannot be made from 7-9 mark questions (2 gives 14-18, 3 gives 21-27)");
    assert(typeof impossibleFailure === "string" && impossibleFailure.includes("cannot be split"), "The impossible budget is refused with a reason that names the numbers");

    const invertedMarksSection = buildMarksRangeSection({ marksPerQuestionMin: 10, marksPerQuestionMax: 4 });
    assert(MockTestSectionGeometry.describeValidationFailure(invertedMarksSection, "Section 1") === null,
        "An inverted marks range collapses to the minimum rather than reporting a contradiction the user cannot see");

    assert(MockTestSectionGeometry.describeValidationFailure(buildMarksRangeSection({ totalMarks: 0 }), "Section 1") !== null, "A marks-range section with no total is refused");
    assert(MockTestSectionGeometry.describeValidationFailure(buildMarksRangeSection({ marksPerQuestionMin: 0, marksPerQuestionMax: 0 }), "Section 1") !== null, "A marks-range section with no marks band is refused");
    assert(MockTestSectionGeometry.describeValidationFailure(buildUniformSection({ name: "   " }), "Section 1") !== null, "A section with a blank name is refused");
    assert(MockTestSectionGeometry.describeValidationFailure(buildUniformSection({ questionCount: 0 }), "Section 1") !== null, "A fixed section with no question count is refused");
    assert(MockTestSectionGeometry.describeValidationFailure(buildUniformSection({ marksPerQuestion: 0, totalMarks: 0 }), "Section 1") !== null, "A uniform section with no marks per question is refused");

    const invertedCountSection = buildUniformSection({ questionCountMode: sectionQuestionCountModes.RANGE, questionCountMin: 6, questionCountMax: 2 });
    assert(MockTestSectionGeometry.describeValidationFailure(invertedCountSection, "Section 1") !== null, "A count range whose maximum is below its minimum is refused");

    // ── Uniform sections derive their TOTAL, not their count ──────────────
    const uniformSection = buildUniformSection();
    const uniformTotalBand = MockTestSectionGeometry.resolveTotalMarksBand(uniformSection, 0);

    assert(!MockTestSectionGeometry.isQuestionCountDerived(uniformSection), "A uniform section does not derive its question count");
    assert(uniformTotalBand.minimum === 80 && uniformTotalBand.maximum === 80, "20 questions x 4 marks totals 80");

    const uniformRangeCountSection = buildUniformSection(
    {
        questionCountMode: sectionQuestionCountModes.RANGE,
        questionCountMin: 2,
        questionCountMax: 6,
        marksPerQuestion: 5
    });
    const uniformRangeTotalBand = MockTestSectionGeometry.resolveTotalMarksBand(uniformRangeCountSection, 0);
    assert(uniformRangeTotalBand.minimum === 10 && uniformRangeTotalBand.maximum === 30, "A count-range uniform section reports its total as a band");

    // ── Sampling weights still steer the expected count ───────────────────
    // Weighted toward 3 (2*2 + 3*5 + 4*1 + 5*1 + 6*1 = 34 over 10 = 3.4), which
    // is deliberately NOT the unweighted midpoint of 2-6 — otherwise the check
    // would pass whether or not the weights were read at all.
    const unweightedSection = buildUniformSection(
    {
        questionCountMode: sectionQuestionCountModes.RANGE,
        questionCountMin: 2,
        questionCountMax: 6
    });
    const weightedSection = buildUniformSection(
    {
        questionCountMode: sectionQuestionCountModes.RANGE,
        questionCountMin: 2,
        questionCountMax: 6,
        questionCountWeights: { "2": 2, "3": 5, "4": 1, "5": 1, "6": 1 }
    });

    assert(MockTestSectionGeometry.resolveExpectedQuestionCount(unweightedSection) === 4, "An unweighted count range expects its midpoint");
    assert(MockTestSectionGeometry.resolveExpectedQuestionCount(weightedSection) === 3,
        "Template-seeded sampling weights still pull the expected count off the midpoint, though they are no longer editable");

    // ── Entries written before marks modes existed ────────────────────────
    const legacySection = {
        name: "Section A (Single-correct MCQ)",
        questionTypes: ["MULTIPLE_CHOICE"],
        questionCount: 60,
        totalMarks: 240,
        correctMarks: 4,
        wrongMarks: -1
    };

    assert(MockTestSectionGeometry.resolveMarksMode(legacySection) === sectionMarksModes.UNIFORM_PER_QUESTION, "A legacy entry with no marks mode reads as uniform");
    assert(MockTestSectionGeometry.resolveMarksPerQuestion(legacySection, 0) === 4, "A legacy entry's marks per question is back-derived from its total and count");
    assert(MockTestSectionGeometry.describeValidationFailure(legacySection, "Section 1") === null, "A legacy entry still validates");

    const legacyWithoutMarks = { name: "Section A", questionTypes: [], questionCount: 10 };
    assert(MockTestSectionGeometry.resolveMarksPerQuestion(legacyWithoutMarks, 3) === 3, "With nothing to derive from, the paper's own correct-marks value is used");

    // ── Paper reconciliation ──────────────────────────────────────────────
    const fixedStructure = [buildUniformSection({ questionCount: 20 }), buildUniformSection({ name: "Section B", questionCount: 10 })];

    assert(MockTestSectionGeometry.describeStructureValidationFailure(fixedStructure, 30, true) === null, "Fixed sections summing to the paper total are accepted");
    assert(MockTestSectionGeometry.describeStructureValidationFailure(fixedStructure, 40, true) !== null, "Fixed sections that do not sum to the paper total are REFUSED, not merely flagged");
    assert(MockTestSectionGeometry.describeStructureValidationFailure(fixedStructure, 40, false) === null, "On AUTOMATIC there are not two numbers to disagree, so nothing is refused");
    assert(MockTestSectionGeometry.describeStructureValidationFailure([], 40, true) === null, "With no sections there is nothing to reconcile");

    const bandedStructure = [buildMarksRangeSection(), buildMarksRangeSection({ name: "Unit IV" })];
    const bandedTotal = MockTestSectionGeometry.resolveStructureQuestionCountBand(bandedStructure);

    assert(bandedTotal.minimum === 4 && bandedTotal.maximum === 10, "Two 4-10 mark / 20 total sections hold between 4 and 10 questions");
    assert(MockTestSectionGeometry.describeStructureValidationFailure(bandedStructure, 7, true) === null, "A paper total INSIDE the achievable band is accepted");
    assert(MockTestSectionGeometry.describeStructureValidationFailure(bandedStructure, 3, true) !== null, "A paper total below the achievable band is refused");
    assert(MockTestSectionGeometry.describeStructureValidationFailure(bandedStructure, 11, true) !== null, "A paper total above the achievable band is refused");

    const firstSectionFailure = MockTestSectionGeometry.describeStructureValidationFailure([buildUniformSection(), impossibleSection], 20, true);
    assert(typeof firstSectionFailure === "string" && firstSectionFailure.startsWith("Section 2:"), "The refusal names WHICH section is at fault");

    // ── The server refuses the same thing the editor does ─────────────────
    section("Tier 1 — server-side refusal");

    const buildSettingsForValidation = (sectionStructure, paperQuestionCount, countMethod) =>
    {
        const generalSettings = new GeneralGenerationSettings();
        generalSettings.setDescription("A syllabus to generate from.");

        const mockTestSettings = new MockTestGenerationSettings();
        mockTestSettings.setSectionStructure(sectionStructure);
        mockTestSettings.setNumQuestionsPerTest(paperQuestionCount);
        mockTestSettings.setNumQuestionsMethod(countMethod);

        return { generalSettings, mockTestSettings };
    };

    const runValidation = (sectionStructure, paperQuestionCount, countMethod) =>
    {
        const { generalSettings, mockTestSettings } = buildSettingsForValidation(sectionStructure, paperQuestionCount, countMethod);
        try
        {
            validateGenerationSettings(generalSettings, null, null, mockTestSettings);
            return null;
        }
        catch (validationError)
        {
            return validationError.message;
        }
    };

    assert(runValidation([buildMarksRangeSection()], 3, automationLevels.MANUAL) === null, "The server accepts a workable marks-driven section");
    assert(runValidation([impossibleSection], 3, automationLevels.MANUAL) !== null, "The server refuses an impossible marks budget even though the client already did");
    assert(runValidation(fixedStructure, 40, automationLevels.MANUAL) !== null, "The server refuses sections that contradict a manually pinned paper total");
    assert(runValidation(fixedStructure, 40, automationLevels.AUTOMATIC) === null, "The server does not reconcile against an automatic paper total");
    assert(runValidation([], 40, automationLevels.MANUAL) === null, "A paper with no sections is unaffected by the new rules");

    const tooManySections = [];
    for (let sectionIndex = 0; sectionIndex < 31; sectionIndex++)
    {
        tooManySections.push(buildUniformSection({ name: `Section ${sectionIndex + 1}`, questionCount: 1 }));
    }
    assert(runValidation(tooManySections, 31, automationLevels.MANUAL) !== null, "An implausible number of sections is refused");

    // ── Every seeded template still describes a workable paper ────────────
    section("Tier 1 — seeded generation templates");

    let templatesChecked = 0;
    let templatesWithSections = 0;

    for (const [templateKey, template] of Object.entries(generationTemplates))
    {
        templatesChecked = templatesChecked + 1;

        const mockTestPatch = template.mockTestPatch || {};
        const sectionStructure = mockTestPatch.setSectionStructure;
        if (!Array.isArray(sectionStructure) || sectionStructure.length === 0)
        {
            continue;
        }

        templatesWithSections = templatesWithSections + 1;

        const bIsManual = mockTestPatch.setNumQuestionsMethod === automationLevels.MANUAL;
        const templateFailure = MockTestSectionGeometry.describeStructureValidationFailure(
            sectionStructure,
            mockTestPatch.setNumQuestionsPerTest,
            bIsManual
        );

        assert(templateFailure === null, `Template ${templateKey} describes a workable paper${templateFailure ? ` — ${templateFailure}` : ""}`);
    }

    assert(templatesChecked > 0, "Generation templates were loaded");
    assert(templatesWithSections >= 20, "Every exam template that defines sections was checked");

    const engineeringTemplateSection = generationTemplates.ENGINEERING_INDIA.mockTestPatch.setSectionStructure[0];
    assert(MockTestSectionGeometry.resolveMarksMode(engineeringTemplateSection) === sectionMarksModes.RANGE_PER_QUESTION,
        "The engineering template now says what it always meant: a marks budget, not a count range with sampling weights");
    assert(engineeringTemplateSection.questionCountWeights === undefined,
        "Its sampling weights are gone — the count is derived from the budget now");
}


function buildFixtureQuestion(questionIndex, typeKey, marks)
{
    return {
        question: `Fixture question ${questionIndex}`,
        expectedAnswer: "Fixture answer",
        answerReason: "Fixture reason",
        solvingSteps: "",
        marks: marks,
        additionalData: { type: questionTypes[typeKey], difficulty: 2 },
        topicChain: ["Fixture Topic"]
    };
}

/**
 * Runs one assembly scenario end to end — writes the task fixtures, drives the
 * real assembler, and returns the persisted mock test's items grouped by
 * section title. Cleans up everything it created.
 */
async function assembleFixtureMockTest(scenarioKey, sectionStructure, fixtureQuestions, paperQuestionCount)
{
    const mainTaskId = `${TEST_TASK_PREFIX}${scenarioKey}-${Date.now()}`;
    const taskDirectory = `${PersistenceConstants.TASKS_DIRECTORY}/${mainTaskId}`;
    const writtenPaths = [];
    const scenarioUserId = `${TEST_USER_ID}-${scenarioKey}`;

    try
    {
        const mockTestSettings = new MockTestGenerationSettings();
        mockTestSettings.setSectionStructure(sectionStructure);
        mockTestSettings.setCorrectMarks(4);
        mockTestSettings.setNumQuestionsPerTest(paperQuestionCount);
        mockTestSettings.setNumQuestionsMethod(automationLevels.MANUAL);

        const blueprint = {
            numberOfTests: 1,
            totalQuestions: paperQuestionCount,
            questionsRepeatChance: 0,
            examName: "",
            subjectName: "Fixture Subject",
            instructions: "",
            duration: 60,
            recursive: false,
            skipRootDeck: false
        };

        const blueprintPath = `${taskDirectory}/${PersistenceConstants.BLUEPRINT_FILE_NAME}`;
        await Persistence.write(blueprintPath, Buffer.from(JSON.stringify(blueprint), "utf-8"));
        writtenPaths.push(blueprintPath);

        const questionsPath = `${taskDirectory}/${PersistenceConstants.MOCK_TEST_QUESTIONS_DIRECTORY}/Fixture.json`;
        await Persistence.write(
            questionsPath,
            Buffer.from(JSON.stringify({ topicChain: ["Fixture Topic"], questions: fixtureQuestions }), "utf-8")
        );
        writtenPaths.push(questionsPath);

        const testsUpserted = await MockTestAssembler.upsertMockTests(
            scenarioUserId,
            `${TEST_TASK_PREFIX}deck`,
            mainTaskId,
            Date.now(),
            mockTestSettings
        );

        const mockTestCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
        const persistedDocument = await mockTestCollection.findOne({ userId: scenarioUserId });

        // Walk the items into sections: a SECTION item opens a bucket, and every
        // QUESTION item after it belongs to that bucket.
        const sectionsByTitle = new Map();
        let currentSectionTitle = null;

        for (const item of (persistedDocument?.data?.items || []))
        {
            if (item.type === 0)
            {
                currentSectionTitle = item.title;
                sectionsByTitle.set(currentSectionTitle, []);
            }
            else if (item.type === 3 && currentSectionTitle !== null)
            {
                sectionsByTitle.get(currentSectionTitle).push(item);
            }
        }

        return { testsUpserted, persistedDocument, sectionsByTitle };
    }
    finally
    {
        try
        {
            const mockTestCollection = (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.MOCK_TESTS_COLLECTION);
            await mockTestCollection.deleteMany({ userId: scenarioUserId });
        }
        catch (cleanupError)
        {
            console.log(`  NOTE  Cleanup of persisted mock tests failed: ${cleanupError.message}`);
        }

        for (const writtenPath of writtenPaths)
        {
            try
            {
                await Persistence.delete(writtenPath);
            }
            catch (cleanupError)
            {
                console.log(`  NOTE  Cleanup of ${writtenPath} failed: ${cleanupError.message}`);
            }
        }
    }
}

async function runDatabaseTier()
{
    section("Tier 2 — assembly against the real storage and database");

    if (process.env.VERIFY_MOCK_TEST_SECTIONS_DB !== "1")
    {
        skip("Database tier not requested (set VERIFY_MOCK_TEST_SECTIONS_DB=1 to run it)");
        return;
    }

    try
    {
        // ── Scenario 1: a marks-driven section beside a fixed one ─────────
        // Marks chosen so a naive largest-first pass MISSES: it takes 10 then
        // 8, leaving 2 marks that nothing fits, and stops at 18 — while
        // 10 + 6 + 4 lands exactly on 20. Anything that does not search for an
        // exact subset fails this case.
        const mixedScenario = await assembleFixtureMockTest(
            "mixed",
            [
                buildMarksRangeSection({ name: "Unit III", questionTypes: ["MEDIUM_SUBJECTIVE"] }),
                buildUniformSection({ name: "Section A", questionCount: 3, marksPerQuestion: 4, totalMarks: 12 })
            ],
            [
                buildFixtureQuestion(1, "MEDIUM_SUBJECTIVE", 4),
                buildFixtureQuestion(2, "MEDIUM_SUBJECTIVE", 6),
                buildFixtureQuestion(3, "MEDIUM_SUBJECTIVE", 10),
                buildFixtureQuestion(4, "MEDIUM_SUBJECTIVE", 8),
                buildFixtureQuestion(5, "MEDIUM_SUBJECTIVE", 5),
                buildFixtureQuestion(6, "MULTIPLE_CHOICE", 4),
                buildFixtureQuestion(7, "MULTIPLE_CHOICE", 4),
                buildFixtureQuestion(8, "MULTIPLE_CHOICE", 4)
            ],
            8
        );

        assert(mixedScenario.testsUpserted === 1, "One mock test was assembled and persisted");
        assert(mixedScenario.persistedDocument !== null, "The assembled mock test was written to the database");

        const unitThreeQuestions = mixedScenario.sectionsByTitle.get("Unit III") || [];
        const sectionAQuestions = mixedScenario.sectionsByTitle.get("Section A") || [];
        const unitThreeMarks = unitThreeQuestions.reduce((sum, item) => sum + (item.marks || 0), 0);

        assert(unitThreeMarks === 20, `The marks-driven section lands exactly on its 20-mark budget (got ${unitThreeMarks})`);
        assert(unitThreeQuestions.length >= 2 && unitThreeQuestions.length <= 5, `Its question count falls inside the derived 2-5 band (got ${unitThreeQuestions.length})`);
        assert(unitThreeQuestions.every(item => item.marks >= 4 && item.marks <= 10), "Every question it claimed is inside the configured marks band");

        assert(sectionAQuestions.length === 3, `The fixed section still takes exactly its configured 3 questions (got ${sectionAQuestions.length})`);
        assert(sectionAQuestions.every(item => item.marks === 4), "The fixed multiple-choice section claimed only its own question type");

        const allClaimedQuestions = [];
        for (const sectionQuestions of mixedScenario.sectionsByTitle.values())
        {
            allClaimedQuestions.push(...sectionQuestions.map(item => item.question));
        }
        assert(new Set(allClaimedQuestions).size === allClaimedQuestions.length, "No question was claimed by two sections");

        // ── Scenario 2: a budget the pool genuinely cannot reach ──────────
        // Three 7-mark questions against a 20-mark budget: 14 is short, 21 is
        // over, and no subset hits 20. The section must still assemble, get as
        // close as it can, and never exceed its derived count band.
        const unreachableScenario = await assembleFixtureMockTest(
            "unreachable",
            [buildMarksRangeSection({ name: "Unit IV", questionTypes: ["MEDIUM_SUBJECTIVE"] })],
            [
                buildFixtureQuestion(1, "MEDIUM_SUBJECTIVE", 7),
                buildFixtureQuestion(2, "MEDIUM_SUBJECTIVE", 7),
                buildFixtureQuestion(3, "MEDIUM_SUBJECTIVE", 7)
            ],
            3
        );

        const unitFourQuestions = unreachableScenario.sectionsByTitle.get("Unit IV") || [];
        const unitFourMarks = unitFourQuestions.reduce((sum, item) => sum + (item.marks || 0), 0);

        assert(unreachableScenario.testsUpserted === 1, "A section whose budget cannot be reached still assembles rather than failing the run");
        assert(unitFourQuestions.length >= 2 && unitFourQuestions.length <= 5, `It stays inside its derived count band (got ${unitFourQuestions.length})`);
        assert(unitFourMarks === 14, `It gets as close to 20 as three 7-mark questions allow (got ${unitFourMarks})`);
        assert(unreachableScenario.sectionsByTitle.has("Unassigned"), "The question it could not use lands in the trailing Unassigned section rather than being dropped");
    }
    catch (databaseTierError)
    {
        assert(false, `Database tier threw: ${databaseTierError.message}`);
        console.error(databaseTierError);
    }
}


async function main()
{
    console.log("CogniumLearn — mock test section structure verification\n");

    await runAlwaysOnTier();
    await runDatabaseTier();

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
