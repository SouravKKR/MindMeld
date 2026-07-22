import { askAiPromptModes } from "../Enumerations/AskAiPromptModes.js";
import { taskTypes } from "../Enumerations/TaskTypes.js";
import { taskStatus } from "../Enumerations/TaskStatus.js";
import { topicStrength } from "../Enumerations/TopicStrength.js";

/**
 * TutorialDemoResponses
 *
 * Hardcoded, fully local stand-ins for every server-backed AI / paid
 * feature the tutorials demonstrate. While a tutorial is running each
 * feature short-circuits its network call and replays the matching
 * canned payload through the real rendering path instead — so the demo
 * costs zero credits, never touches the server, and offers nothing for a
 * malicious user to exploit (the client simply never contacts the
 * server; canned local text is worthless to farm).
 *
 * Every payload here is shaped to match exactly what the corresponding
 * renderer already consumes:
 *   - getAskAiEvents          → AskAiSession.#handleNdjsonLine NDJSON events
 *   - getPaidDeckSearchResult → PaidDeckLibraryPage.#renderResults
 *   - getGenerationProgressSnapshots → GenerationProgressComponent.update
 *   - getLastAnalysisTopics   → TopicInsights (deck.additionalData block)
 */
class TutorialDemoResponses
{
    // Small inter-chunk delay so the canned Ask-AI reply visibly "streams"
    // the way a real response does, rather than appearing all at once.
    static ASK_AI_CHUNK_DELAY_MILLISECONDS = 220;

    // Cadence of the faked generation pipeline as it climbs to completion.
    static GENERATION_STEP_DELAY_MILLISECONDS = 900;

    static GENERATED_DECK_NAME = "AI-Generated: Photosynthesis";
    static GENERATED_DECK_SHORT_NAME = "Photosynthesis";

    static BOGUS_PAID_DECK_ID = "tutorial-sample-paid-deck";

    // The HTML body shown for each Ask-AI prompt mode, pre-split into a few
    // fragments so playback mimics token streaming. Keyed by the
    // askAiPromptModes enum value. Content is written about the sample
    // deck's subject (the CogniumLearn learning lifecycle) so it reads as a
    // genuine in-context answer.
    static #ASK_AI_BODY_CHUNKS_BY_MODE = new Map
    ([
        [askAiPromptModes.EXPLAIN,
        [
            "<h3>The Encode phase, in plain terms</h3>",
            "<p>Encoding is where a fact stops being something you just read and becomes something you can actually recall. In CogniumLearn this is the job of <strong>Spaced Repetition</strong>.</p>",
            "<p>Spaced Repetition estimates the day your memory of each card is about to dip below a usable level, and shows you the card right then — not too early (wasteful) and not too late (already forgotten). Each honest rating you give nudges that estimate, so the schedule keeps tightening around how <em>you</em> actually remember.</p>"
        ]],
        [askAiPromptModes.SUMMARIZE,
        [
            "<h3>Lifecycle — one-screen cheat sheet</h3>",
            "<ul><li><strong>Acquire</strong> — pull material in.</li><li><strong>Encode</strong> — Spaced Repetition burns it in.</li><li><strong>Consolidate</strong> — Revise marked cards.</li>",
            "<li><strong>Validate</strong> — Mock Tests under exam pressure.</li><li><strong>Reflect</strong> — Deck Insights shows weak / strong / confused topics.</li></ul>"
        ]],
        [askAiPromptModes.ASK,
        [
            "<p>Great question. <strong>Revise</strong> and <strong>Spaced Repetition</strong> look similar but serve different phases.</p>",
            "<p>Spaced Repetition (Encode) schedules cards by when you're next due to see them, for long-term retention. Revise (Consolidate) is a quick linear pass over only the cards you've marked for review — ideal the night before an exam.</p>"
        ]],
        [askAiPromptModes.FORMAT,
        [
            "<h3>Formatted</h3>",
            "<p>The five phases, cleanly laid out:</p>",
            "<ol><li>Acquire</li><li>Encode</li><li>Consolidate</li><li>Validate</li><li>Reflect</li></ol>"
        ]],
        [askAiPromptModes.MAKE_MNEMONIC,
        [
            "<h3>A mnemonic for the five phases</h3>",
            "<p><strong>\"A Eager Cat Validates Results\"</strong> — <em>A</em>cquire, <em>E</em>ncode, <em>C</em>onsolidate, <em>V</em>alidate, <em>R</em>eflect.</p>"
        ]],
        [askAiPromptModes.GIVE_EXAMPLES,
        [
            "<h3>Examples of each phase</h3>",
            "<ul><li><strong>Acquire</strong> — upload a chapter PDF.</li><li><strong>Encode</strong> — a daily Spaced Repetition session.</li>",
            "<li><strong>Consolidate</strong> — a Revise pass over flagged cards.</li><li><strong>Validate</strong> — a timed Mock Test.</li><li><strong>Reflect</strong> — reading your Deck Insights.</li></ul>"
        ]],
        [askAiPromptModes.GLOSSARY,
        [
            "<h3>Glossary</h3>",
            "<ul><li><strong>Spaced Repetition</strong> — reviews timed to just before you'd forget.</li><li><strong>Recall</strong> — bringing an answer to mind without looking it up.</li>",
            "<li><strong>Lapse</strong> — a failed recall, which shortens the next interval.</li></ul>"
        ]]
    ]);

    // A couple of plausible sources so the citations footer (a Pro-tier
    // feature) is demonstrated on the Ask flow.
    static #ASK_AI_DEMO_CITATIONS =
    [
        { uri: "https://en.wikipedia.org/wiki/Spaced_repetition", title: "Spaced repetition — Wikipedia" },
        { uri: "https://en.wikipedia.org/wiki/Forgetting_curve", title: "Forgetting curve — Wikipedia" }
    ];

    /**
     * Returns the ordered NDJSON event list for an Ask-AI prompt mode,
     * ready to feed one-by-one through AskAiSession.#handleNdjsonLine.
     * Falls back to the EXPLAIN body for any unmapped mode.
     * @param {number} promptMode
     * @returns {object[]}
     */
    static getAskAiEvents(promptMode)
    {
        const bodyChunks = TutorialDemoResponses.#ASK_AI_BODY_CHUNKS_BY_MODE.get(promptMode)
            || TutorialDemoResponses.#ASK_AI_BODY_CHUNKS_BY_MODE.get(askAiPromptModes.EXPLAIN);

        const events = bodyChunks.map((chunkValue) => ({ type: "text", value: chunkValue }));

        // Demonstrate the grounded-sources footer on the Ask mode only —
        // that mirrors real life, where citations come back on the
        // search-grounded tiers.
        if (promptMode === askAiPromptModes.ASK)
        {
            events.push({ type: "citations", sources: TutorialDemoResponses.#ASK_AI_DEMO_CITATIONS });
        }

        events.push({ type: "done" });
        return events;
    }

    /**
     * The single bogus paid deck shown in the library / details demo.
     * Shaped like one entry of a /PaidDecks/Search `decks` array — every
     * field PaidDeckLibraryPage and PaidDeckDetailsPage read is present.
     * @returns {object}
     */
    static getBogusPaidDeck()
    {
        return {
            id: TutorialDemoResponses.BOGUS_PAID_DECK_ID,
            title: "NEET Biology — Complete Crash Course (Sample)",
            description: "A sample storefront listing used only inside this tutorial. Clicking Buy here makes no real purchase — it just shows you how the Paid Deck Library works.",
            category: "Medical Entrance",
            currency: "INR",
            basePriceMinor: 49900,
            computedPrice:
            {
                basePriceMinor: 49900,
                finalPriceMinor: 29900,
                currency: "INR",
                reason: "DISCOUNTED"
            },
            contentSummary:
            {
                totalCards: 1240,
                totalStudyMaterials: 38,
                totalMockTests: 12,
                treeSnapshot: []
            },
            tags: ["neet", "biology", "sample"],
            extraTags: ["Demo"],
            featureBadges: []
        };
    }

    /**
     * The canned /PaidDecks/Search response body for the library demo.
     * @returns {object}
     */
    static getPaidDeckSearchResult()
    {
        return {
            decks: [TutorialDemoResponses.getBogusPaidDeck()],
            totalCount: 1,
            region: "IN",
            offset: 0,
            limit: 24
        };
    }

    /**
     * An ordered list of task-tree snapshots that climb from "queued" to
     * a fully completed pipeline, each shaped like a /Generate/Progress
     * payload for GenerationProgressComponent.update(). The last entry is
     * terminal (every node COMPLETED) so the progress page shows its
     * success banner. The root is intentionally NOT typed
     * PREPARE_FOR_GENERATION-with-a-real-task so the page's credit-summary
     * fetch is never attempted (the page also guards that on tutorial
     * mode).
     * @returns {object[]}
     */
    static getGenerationProgressSnapshots()
    {
        const buildTree = (syllabusCompletion, flashcardCompletion, studyMaterialCompletion) =>
        {
            const statusFor = (completion) =>
            {
                if (completion >= 1) return taskStatus.COMPLETED;
                if (completion > 0)  return taskStatus.IN_PROGRESS;
                return taskStatus.NOT_STARTED;
            };

            const overallCompletion = (syllabusCompletion + flashcardCompletion + studyMaterialCompletion) / 3;

            return {
                id: "tutorial-demo-root",
                type: taskTypes.PREPARE_FOR_GENERATION,
                status: statusFor(overallCompletion),
                completion: overallCompletion,
                parentTaskId: null,
                children:
                [
                    {
                        id: "tutorial-demo-syllabus",
                        type: taskTypes.PROCESS_SYLLABUS,
                        status: statusFor(syllabusCompletion),
                        completion: syllabusCompletion,
                        parentTaskId: "tutorial-demo-root",
                        children: []
                    },
                    {
                        id: "tutorial-demo-flashcards",
                        type: taskTypes.GENERATE_FLASHCARDS,
                        status: statusFor(flashcardCompletion),
                        completion: flashcardCompletion,
                        parentTaskId: "tutorial-demo-root",
                        children: []
                    },
                    {
                        id: "tutorial-demo-study-material",
                        type: taskTypes.GENERATE_STUDY_MATERIAL,
                        status: statusFor(studyMaterialCompletion),
                        completion: studyMaterialCompletion,
                        parentTaskId: "tutorial-demo-root",
                        children: []
                    }
                ]
            };
        };

        return [
            buildTree(0.2, 0, 0),
            buildTree(1, 0.4, 0),
            buildTree(1, 1, 0.5),
            buildTree(1, 1, 1)
        ];
    }

    /**
     * The hardcoded grading for the sample mock test's answer-key demo, one
     * entry per question in sample-deck order. `selectedIndices` is the
     * candidate's recorded choice (serialised to the JSON index set the
     * answer key decodes), `score` the marks awarded (out of 1), and
     * `remarks` an optional examiner note. Deliberately mixed — two correct,
     * one wrong with a note — so the answer key shows a realistic result.
     * @returns {object[]}
     */
    static getMockTestGradedSpec()
    {
        return [
            { selectedIndices: [1], score: 1, remarks: "" },
            { selectedIndices: [2], score: 1, remarks: "" },
            { selectedIndices: [0], score: 0, remarks: "<p>You chose Acquire, but Deck Insights belongs to the <strong>Reflect</strong> phase. Re-read the lifecycle summary card.</p>" }
        ];
    }

    /**
     * The canned `lastAnalysisTopics` block seeded onto the sample deck so
     * Deck Insights renders populated weak / strong / confused panels with
     * no analysis run. `generatedAt` is stamped by the caller (the builder)
     * so this stays a pure literal. Strength values are the enum NAMES, as
     * the backend persists and TopicInsights compares against.
     * @returns {object[]}
     */
    static getLastAnalysisTopics()
    {
        const strengthName = (strengthValue) =>
        {
            for (const enumKey of Object.keys(topicStrength))
            {
                if (topicStrength[enumKey] === strengthValue)
                {
                    return enumKey;
                }
            }
            return "WEAK";
        };

        return [
            { name: "The Encode phase", strength: strengthName(topicStrength.STRONG), reason: "You rate these cards Easy almost every time — retention is solid." },
            { name: "Revise vs Spaced Repetition", strength: strengthName(topicStrength.WEAK), reason: "You've reviewed these only a few times and recall has been shaky — worth more practice." },
            { name: "The five phases", strength: strengthName(topicStrength.VOLATILE), reason: "Your last few attempts flip between right and wrong — the concept hasn't settled yet." }
        ];
    }
}

export default TutorialDemoResponses;
