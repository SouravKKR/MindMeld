import Deck from "../../Model/Deck.js";
import Card from "../../Model/Card.js";
import StudyMaterial from "../../Model/StudyMaterial.js";
import Lifecycle from "../../Model/Lifecycle.js";
import Progress from "../../Model/Progress.js";
import DeckEvents from "../../Events/DeckEvents.js";
import { studyMaterialDetailLevels } from "../../Enumerations/StudyMaterialDetailLevels.js";
import { questionTypes } from "../../Enumerations/QuestionTypes.js";
import { getRandomUuid } from "../../UtilityFunctions/GetRandomUuid.js";
import { mockTestItemTypes } from "../../Enumerations/MockTestItemTypes.js";
import { mockTestEvaluationStatuses } from "../../Enumerations/MockTestEvaluationStatuses.js";
import MockTest from "../../Model/MockTest.js";
import MockTestQuestion from "../../Model/MockTestEntities/MockTestQuestion.js";
import MockTestItemFactory from "../../Model/MockTestEntities/MockTestItemFactory.js";
import MockTestAttempt from "../../Model/MockTestEntities/MockTestAttempt.js";
import AutoAnalysisDeckFields from "../Analysis/AutoAnalysisDeckFields.js";
import TutorialDemoResponses from "../../Constants/TutorialDemoResponses.js";
import TutorialEngine from "../TutorialEngine.js";

/**
 * TutorialSampleDeckBuilder
 *
 * Builds self-contained sample decks the study / AI-features tutorials
 * walk through. Every entity it creates carries the
 * `CREATED_DURING_TUTORIAL_KEY` flag so the existing TutorialEntityCleanup
 * pass deletes the lot when the user finishes or skips the tutorial —
 * no separate teardown wiring required.
 *
 * The main sample deck (createForUser) teaches the CogniumLearn learning
 * lifecycle, and additionally carries an MCQ mock test (so the
 * grading demo runs fully offline) and a seeded `lastAnalysisTopics`
 * block (so Deck Insights renders populated panels without an analysis
 * run). The generated / purchased helpers stand in for the results of
 * the AI-generation and paid-deck-purchase demos.
 */
class TutorialSampleDeckBuilder
{
    static SAMPLE_DECK_NAME        = "Tutorial Sample Deck";
    static SAMPLE_DECK_SHORT_NAME  = "Tutorial";

    static #SAMPLE_CARDS =
    [
        {
            question: "<p>What are the five phases of the CogniumLearn learning lifecycle?</p>",
            answer:   "<p><strong>Acquire → Encode → Consolidate → Validate → Reflect.</strong> Every feature in the app serves at least one of these phases.</p>"
        },
        {
            question: "<p>Which study mode in CogniumLearn is built for the <em>Encode</em> phase?</p>",
            answer:   "<p><strong>Spaced Repetition</strong> — it shows each card on the day your memory of it is about to lapse, so the answer burns in instead of fading.</p>"
        },
        {
            question: "<p>What's the difference between <em>Revise</em> and <em>Spaced Repetition</em> in CogniumLearn?</p>",
            answer:   "<p>Revise is a quick, linear glance-through of cards you've marked for review. Spaced Repetition schedules cards by when you're next due to see them and is meant for long-term retention — Revise is meant for short-term polish right before a test or recall session.</p>"
        }
    ];

    static #STANDARD_STUDY_MATERIAL_CONTENT = `
        <h2>The CogniumLearn Learning Lifecycle</h2>
        <p>CogniumLearn treats studying for an exam as a five-phase journey instead of a single act of memorisation. Each phase has its own goals, and the app gives you a different set of tools for each one.</p>

        <h3>1. Acquire</h3>
        <p>Capture material from any source — your textbook, your notes, a PDF, a website, even a quick voice memo. The Acquire phase is about getting raw information into the deck. You can paste content directly, upload a syllabus and let the app generate flashcards, or import an existing deck from a friend.</p>

        <h3>2. Encode</h3>
        <p>Burn the material into long-term memory using <strong>Spaced Repetition</strong>. It shows you each card on the day your retention is about to dip, so every review actually moves the needle. The bottom panel on this screen lets you ask the AI a question about whatever you're reading right now — useful when a definition isn't sticking.</p>

        <h3>3. Consolidate</h3>
        <p>Strengthen the pathways you built in the Encode phase. <strong>Revise</strong> is a quick linear glance over cards you've marked for review — perfect for the day before a test. Curated Study generates focused materials for the topics you're weakest in, drawn from your own notes plus the web.</p>

        <h3>4. Validate</h3>
        <p>Prove what you know under exam conditions. <strong>Mock Tests</strong> simulate the real assessment so you can see whether your knowledge holds up under pressure, not just in a comfortable review session.</p>

        <h3>5. Reflect</h3>
        <p><strong>Deck Insights</strong> shows you exactly where you stand: which topics are confident, which are shaky, which keep flipping between right and wrong. The point isn't a single number — it's a map of where your remaining effort should go.</p>

        <h3>Why a lifecycle at all?</h3>
        <p>Most flashcard apps stop at phase two: memorisation. CogniumLearn treats memorisation as one fifth of the problem. If you only encode, you never learn whether you can actually use what you've memorised in an exam-shaped situation — and you never learn what to study next.</p>
    `;

    static #SUMMARY_STUDY_MATERIAL_CONTENT = `
        <h2>Lifecycle cheat sheet</h2>
        <ul>
            <li><strong>Acquire</strong> — pull material in (notes, PDFs, web, AI generation).</li>
            <li><strong>Encode</strong> — Spaced Repetition schedules reviews to burn material in.</li>
            <li><strong>Consolidate</strong> — Revise marked cards; Curated Study fills weak-topic gaps.</li>
            <li><strong>Validate</strong> — Mock Tests under exam conditions.</li>
            <li><strong>Reflect</strong> — Deck Insights shows weak / strong / volatile topics.</li>
        </ul>
    `;

    // Each entry is a single-correct MCQ. `correctIndex` is serialised into
    // the question's expectedAnswer as a JSON index set ("[1]"), the exact
    // shape MockTestAttempt.evaluate() parses for offline grading.
    static #SAMPLE_MOCK_TEST_QUESTIONS =
    [
        {
            question: "Which study mode in CogniumLearn is built for the Encode phase?",
            options: ["Revise", "Spaced Repetition", "Mock Test", "Deck Insights"],
            correctIndex: 1,
            answerReason: "Spaced Repetition is the scheduled-review mode that drives long-term encoding."
        },
        {
            question: "Which phase is about proving your knowledge under exam conditions?",
            options: ["Acquire", "Encode", "Validate", "Reflect"],
            correctIndex: 2,
            answerReason: "Validate is the exam-simulation phase — that's what Mock Tests are for."
        },
        {
            question: "Deck Insights — weak / strong / confused topics — belongs to which phase?",
            options: ["Acquire", "Encode", "Consolidate", "Reflect"],
            correctIndex: 3,
            answerReason: "Reflect is the phase where you review where you stand and decide what to study next."
        }
    ];

    /**
     * Builds and persists the main sample deck for the current user. Returns
     * the newly-created Deck instance. The deck is attached to the root,
     * shows up on the Home grid immediately, and is automatically removed
     * by TutorialEntityCleanup when the tutorial finishes or is skipped.
     */
    static async createForUser()
    {
        const rootDeck = TutorialSampleDeckBuilder.#requireRootDeck();

        const sampleDeck = TutorialSampleDeckBuilder.#buildFlaggedDeck(
            rootDeck,
            TutorialSampleDeckBuilder.SAMPLE_DECK_NAME,
            TutorialSampleDeckBuilder.SAMPLE_DECK_SHORT_NAME,
            TutorialSampleDeckBuilder.#buildSeededAnalysisData()
        );

        TutorialSampleDeckBuilder.#attachSampleCards(sampleDeck);
        TutorialSampleDeckBuilder.#attachSampleStudyMaterials(sampleDeck);
        TutorialSampleDeckBuilder.#attachSampleMockTest(sampleDeck);

        await TutorialSampleDeckBuilder.#persist(sampleDeck, rootDeck);
        return sampleDeck;
    }

    /**
     * Stands in for the deck a real AI generation would produce. Used by the
     * ProgressPage tutorial demo once the faked pipeline reaches 100% so the
     * "your decks are ready" claim is truthful. Flagged for cleanup.
     */
    static async createGeneratedSampleForUser()
    {
        const rootDeck = TutorialSampleDeckBuilder.#requireRootDeck();

        const generatedDeck = TutorialSampleDeckBuilder.#buildFlaggedDeck(
            rootDeck,
            TutorialDemoResponses.GENERATED_DECK_NAME,
            TutorialDemoResponses.GENERATED_DECK_SHORT_NAME,
            {}
        );

        const generatedCard = TutorialSampleDeckBuilder.#buildFlaggedCard(
            generatedDeck.getId(),
            "<p>What is the overall word equation for photosynthesis?</p>",
            "<p>Carbon dioxide + water → glucose + oxygen, powered by light energy captured by chlorophyll.</p>"
        );
        generatedDeck.addCard(generatedCard);

        const generatedMaterial = new StudyMaterial(
            StudyMaterial.generateId(),
            "<h2>Photosynthesis (AI-generated sample)</h2><p>This deck stands in for what CogniumLearn's AI would generate from a syllabus or your notes. In a real run it would contain dozens of flashcards, study materials and mock tests built from your source material.</p>",
            generatedDeck.getId(),
            new Lifecycle(),
            0,
            studyMaterialDetailLevels.STANDARD
        );
        generatedDeck.addStudyMaterial(generatedMaterial);

        await TutorialSampleDeckBuilder.#persist(generatedDeck, rootDeck);
        return generatedDeck;
    }

    /**
     * Stands in for a deck "bought" from the paid-deck library during the
     * tutorial. No payment is taken and no server is contacted — this just
     * drops a flagged local copy onto the home page so the purchase demo
     * has a tangible result. Flagged for cleanup.
     * @param {string} sourceTitle - the bogus paid deck's title, if available.
     */
    static async createPurchasedSampleForUser(sourceTitle)
    {
        const rootDeck = TutorialSampleDeckBuilder.#requireRootDeck();

        const deckName = (typeof sourceTitle === "string" && sourceTitle.trim().length > 0)
            ? sourceTitle.trim()
            : "Sample Purchased Deck";

        const purchasedDeck = TutorialSampleDeckBuilder.#buildFlaggedDeck(rootDeck, deckName, "Sample", {});

        const purchasedCard = TutorialSampleDeckBuilder.#buildFlaggedCard(
            purchasedDeck.getId(),
            "<p>What does buying a paid deck give you?</p>",
            "<p>A ready-made deck of flashcards, study materials and mock tests built by an educator — no generation needed. (This copy is a tutorial sample, not a real purchase.)</p>"
        );
        purchasedDeck.addCard(purchasedCard);

        await TutorialSampleDeckBuilder.#persist(purchasedDeck, rootDeck);
        return purchasedDeck;
    }

    /**
     * Locates the main sample deck created by createForUser (by name + the
     * tutorial flag) so a later tutorial step can reach its mock test.
     * Returns null if it isn't present.
     */
    static findSampleDeck()
    {
        return Deck.getAll().find((deck) =>
            !deck.isRoot()
            && deck.getName() === TutorialSampleDeckBuilder.SAMPLE_DECK_NAME
            && deck.getAdditionalData?.()?.[TutorialEngine.CREATED_DURING_TUTORIAL_KEY] === true
        ) || null;
    }

    /**
     * Returns the sample deck's mock test (the MCQ paper), or null if the
     * sample deck or its mock test isn't present.
     */
    static findSampleMockTest()
    {
        const sampleDeck = TutorialSampleDeckBuilder.findSampleDeck();
        if (!sampleDeck)
        {
            return null;
        }
        const mockTests = sampleDeck.getMockTests(false);
        return Array.isArray(mockTests) && mockTests.length > 0 ? mockTests[0] : null;
    }

    /**
     * Builds a fully-graded, in-memory MockTestAttempt for the sample mock
     * test using the hardcoded grading spec. The attempt's question items
     * are deep clones of the blueprint (so their ids match, which the answer
     * key page relies on to pair graded data with each question) stamped
     * with a recorded answer, score and examiner note. Nothing is saved or
     * synced — the answer key page just renders it. Returns null when the
     * mock test has no questions.
     * @param {MockTest} sampleMockTest
     * @returns {MockTestAttempt|null}
     */
    static buildGradedSampleAttempt(sampleMockTest)
    {
        if (!sampleMockTest)
        {
            return null;
        }

        const gradedSpec = TutorialDemoResponses.getMockTestGradedSpec();
        const clonedItems = sampleMockTest.getItems().map((item) => MockTestItemFactory.fromJson(item.toJson()));

        let questionCursor = 0;
        let totalScore = 0;
        let maxScore = 0;

        for (const clonedItem of clonedItems)
        {
            if (clonedItem.getType() !== mockTestItemTypes.QUESTION)
            {
                continue;
            }

            const spec = gradedSpec[questionCursor] || { selectedIndices: [], score: 0, remarks: "" };
            clonedItem.setAnswer(JSON.stringify(spec.selectedIndices));
            clonedItem.setScore(spec.score);
            clonedItem.setMarks(1);
            clonedItem.setRemarks(spec.remarks);

            totalScore += spec.score;
            maxScore += 1;
            questionCursor += 1;
        }

        if (questionCursor === 0)
        {
            return null;
        }

        return new MockTestAttempt(
            getRandomUuid(),
            new Date(),
            clonedItems,
            totalScore,
            maxScore,
            {},
            mockTestEvaluationStatuses.COMPLETED
        );
    }

    static #requireRootDeck()
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            throw new Error("TutorialSampleDeckBuilder: root deck not initialised yet");
        }
        return rootDeck;
    }

    /**
     * Saves a freshly-built sample deck (its own file with embedded cards /
     * materials / mock tests) AND the root (whose subDecks array now includes
     * the new id), then tells the Home page to rebuild its grid.
     */
    static async #persist(sampleDeck, rootDeck)
    {
        await sampleDeck.save(false);
        await rootDeck.save(false);
        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: rootDeck}}));
    }

    /**
     * Builds the seeded auto-analysis block for the main sample deck so Deck
     * Insights shows populated weak / strong / confused panels without any
     * analysis ever running on the server.
     */
    static #buildSeededAnalysisData()
    {
        return {
            [AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS]:
            {
                topics: TutorialDemoResponses.getLastAnalysisTopics(),
                deckChain: [TutorialSampleDeckBuilder.SAMPLE_DECK_NAME],
                generatedAt: new Date().toISOString()
            }
        };
    }

    static #buildFlaggedDeck(rootDeck, name, shortName, extraAdditionalData)
    {
        const additionalData = { ...extraAdditionalData, [TutorialEngine.CREATED_DURING_TUTORIAL_KEY]: true };

        // The Deck constructor itself wires the new deck into root's
        // subDecks list via parent.addSubDeck(this). No further attachment
        // needed here.
        return new Deck(
            Deck.generateId(),
            name,
            shortName,
            [],
            [],
            new Lifecycle(),
            [],
            [],
            [],
            rootDeck,
            additionalData
        );
    }

    static #buildFlaggedCard(deckId, question, answer)
    {
        return new Card(
            Card.generateId(),
            question,
            answer,
            [],
            deckId,
            1500,
            new Progress(),
            new Lifecycle(),
            { [TutorialEngine.CREATED_DURING_TUTORIAL_KEY]: true }
        );
    }

    static #attachSampleCards(sampleDeck)
    {
        for (const cardTemplate of TutorialSampleDeckBuilder.#SAMPLE_CARDS)
        {
            sampleDeck.addCard(TutorialSampleDeckBuilder.#buildFlaggedCard(sampleDeck.getId(), cardTemplate.question, cardTemplate.answer));
        }
    }

    static #attachSampleStudyMaterials(sampleDeck)
    {
        const standardMaterial = new StudyMaterial(
            StudyMaterial.generateId(),
            TutorialSampleDeckBuilder.#STANDARD_STUDY_MATERIAL_CONTENT,
            sampleDeck.getId(),
            new Lifecycle(),
            0,
            studyMaterialDetailLevels.STANDARD
        );
        sampleDeck.addStudyMaterial(standardMaterial);

        const summaryMaterial = new StudyMaterial(
            StudyMaterial.generateId(),
            TutorialSampleDeckBuilder.#SUMMARY_STUDY_MATERIAL_CONTENT,
            sampleDeck.getId(),
            new Lifecycle(),
            1,
            studyMaterialDetailLevels.SUMMARY
        );
        sampleDeck.addStudyMaterial(summaryMaterial);
    }

    /**
     * Attaches an MCQ-only mock test to the sample deck. Because every
     * question is multiple-choice, the submit flow grades it entirely
     * offline (MockTestAttempt.evaluate) with no server call — which is
     * exactly what the tutorial relies on for a zero-cost grading demo.
     */
    static #attachSampleMockTest(sampleDeck)
    {
        const questionItems = TutorialSampleDeckBuilder.#SAMPLE_MOCK_TEST_QUESTIONS.map((questionTemplate) =>
        {
            return new MockTestQuestion(
                getRandomUuid(),
                questionTemplate.question,
                JSON.stringify([questionTemplate.correctIndex]),
                questionTemplate.answerReason,
                1,
                "",
                0,
                { type: questionTypes.MULTIPLE_CHOICE, options: questionTemplate.options }
            );
        });

        const sampleMockTest = new MockTest(
            MockTest.generateId(),
            sampleDeck.getId(),
            "Sample Mock Test — The Learning Lifecycle",
            10,
            questionItems,
            [],
            new Lifecycle(),
            null
        );

        sampleDeck.addMockTest(sampleMockTest);
    }
}

export default TutorialSampleDeckBuilder;
