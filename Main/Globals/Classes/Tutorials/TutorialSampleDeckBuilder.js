import Deck from "../../Model/Deck.js";
import Card from "../../Model/Card.js";
import StudyMaterial from "../../Model/StudyMaterial.js";
import Lifecycle from "../../Model/Lifecycle.js";
import Progress from "../../Model/Progress.js";
import DeckEvents from "../../Events/DeckEvents.js";
import { studyMaterialDetailLevels } from "../../Enumerations/StudyMaterialDetailLevels.js";
import TutorialEngine from "../TutorialEngine.js";

/**
 * TutorialSampleDeckBuilder
 *
 * Builds a self-contained sample deck the "How to Study" tutorial walks
 * through. Every entity it creates carries the
 * `CREATED_DURING_TUTORIAL_KEY` flag so the existing TutorialEntityCleanup
 * pass deletes the lot when the user finishes or skips the tutorial —
 * no separate teardown wiring required.
 *
 * Topic was chosen for self-containment: the sample teaches the
 * MindMeld learning lifecycle so the demo deck is meaningful even if
 * the user never opens it again, and the study material's text gives
 * the text-selection menu something concrete to grab.
 */
class TutorialSampleDeckBuilder
{
    static SAMPLE_DECK_NAME        = "Tutorial Sample Deck";
    static SAMPLE_DECK_SHORT_NAME  = "Tutorial";

    static #SAMPLE_CARDS =
    [
        {
            question: "<p>What are the five phases of the MindMeld learning lifecycle?</p>",
            answer:   "<p><strong>Acquire → Encode → Consolidate → Validate → Reflect.</strong> Every feature in the app serves at least one of these phases.</p>"
        },
        {
            question: "<p>Which study mode in MindMeld is built for the <em>Encode</em> phase?</p>",
            answer:   "<p><strong>Spaced Repetition</strong> — the FSRS scheduler shows each card on the day your memory of it is about to lapse, so the answer burns in instead of fading.</p>"
        },
        {
            question: "<p>What's the difference between <em>Revise</em> and <em>Spaced Repetition</em> in MindMeld?</p>",
            answer:   "<p>Revise is a quick, linear glance-through of cards you've marked for review. Spaced Repetition orders cards by the FSRS due-date queue and is meant for long-term retention — Revise is meant for short-term polish right before a test or recall session.</p>"
        }
    ];

    static #STANDARD_STUDY_MATERIAL_CONTENT = `
        <h2>The MindMeld Learning Lifecycle</h2>
        <p>MindMeld treats studying for an exam as a five-phase journey instead of a single act of memorisation. Each phase has its own goals, and the app gives you a different set of tools for each one.</p>

        <h3>1. Acquire</h3>
        <p>Capture material from any source — your textbook, your notes, a PDF, a website, even a quick voice memo. The Acquire phase is about getting raw information into the deck. You can paste content directly, upload a syllabus and let the app generate flashcards, or import an existing deck from a friend.</p>

        <h3>2. Encode</h3>
        <p>Burn the material into long-term memory using <strong>Spaced Repetition</strong>. The FSRS scheduler shows you each card on the day your retention is about to dip below the threshold, so every review actually moves the needle. The bottom panel on this screen lets you ask the AI a question about whatever you're reading right now — useful when a definition isn't sticking.</p>

        <h3>3. Consolidate</h3>
        <p>Strengthen the pathways you built in the Encode phase. <strong>Revise</strong> is a quick linear glance over cards you've marked for review — perfect for the day before a test. Curated Study generates focused materials for the topics you're weakest in, drawn from your own notes plus the web.</p>

        <h3>4. Validate</h3>
        <p>Prove what you know under exam conditions. <strong>Mock Tests</strong> simulate the real assessment so you can see whether your knowledge holds up under pressure, not just in a comfortable review session.</p>

        <h3>5. Reflect</h3>
        <p><strong>Deck Insights</strong> shows you exactly where you stand: which topics are confident, which are shaky, which keep flipping between right and wrong. The point isn't a single number — it's a map of where your remaining effort should go.</p>

        <h3>Why a lifecycle at all?</h3>
        <p>Most flashcard apps stop at phase two: memorisation. MindMeld treats memorisation as one fifth of the problem. If you only encode, you never learn whether you can actually use what you've memorised in an exam-shaped situation — and you never learn what to study next.</p>
    `;

    static #SUMMARY_STUDY_MATERIAL_CONTENT = `
        <h2>Lifecycle cheat sheet</h2>
        <ul>
            <li><strong>Acquire</strong> — pull material in (notes, PDFs, web, AI generation).</li>
            <li><strong>Encode</strong> — Spaced Repetition, FSRS due-dates burn material in.</li>
            <li><strong>Consolidate</strong> — Revise marked cards; Curated Study fills weak-topic gaps.</li>
            <li><strong>Validate</strong> — Mock Tests under exam conditions.</li>
            <li><strong>Reflect</strong> — Deck Insights shows weak / strong / volatile topics.</li>
        </ul>
    `;

    /**
     * Builds and persists the sample deck for the current user. Returns
     * the newly-created Deck instance. The deck is attached to the root,
     * shows up on the Home grid immediately, and is automatically removed
     * by TutorialEntityCleanup when the tutorial finishes or is skipped.
     */
    static async createForUser()
    {
        const rootDeck = Deck.getRoot();
        if (!rootDeck)
        {
            throw new Error("TutorialSampleDeckBuilder.createForUser: root deck not initialised yet");
        }

        const sampleDeck = TutorialSampleDeckBuilder.#buildEmptyDeck(rootDeck);

        TutorialSampleDeckBuilder.#attachSampleCards(sampleDeck);
        TutorialSampleDeckBuilder.#attachSampleStudyMaterials(sampleDeck);

        // Save the sample deck (its own .mmd file with embedded cards +
        // materials) AND the root (whose subDecks array now includes
        // the new id). Without saving root, a fresh-page-load would
        // reconstruct the tree without the sample deck attached.
        await sampleDeck.save(false);
        await rootDeck.save(false);

        // Tell the Home page to rebuild its grid so the user sees the
        // new tile right away.
        window.dispatchEvent(new CustomEvent(DeckEvents.EXPAND, {detail: {deck: rootDeck}}));

        return sampleDeck;
    }

    static #buildEmptyDeck(rootDeck)
    {
        const deckId = Deck.generateId();
        const lifecycle = new Lifecycle();
        const additionalData = { [TutorialEngine.CREATED_DURING_TUTORIAL_KEY]: true };

        // The Deck constructor itself wires the new deck into root's
        // subDecks list via parent.addSubDeck(this) — see Deck.js's
        // constructor tail. No further attachment needed here.
        return new Deck(
            deckId,
            TutorialSampleDeckBuilder.SAMPLE_DECK_NAME,
            TutorialSampleDeckBuilder.SAMPLE_DECK_SHORT_NAME,
            [],
            [],
            lifecycle,
            [],
            [],
            [],
            rootDeck,
            additionalData
        );
    }

    static #attachSampleCards(sampleDeck)
    {
        for (const cardTemplate of TutorialSampleDeckBuilder.#SAMPLE_CARDS)
        {
            const card = new Card(
                Card.generateId(),
                cardTemplate.question,
                cardTemplate.answer,
                [],
                sampleDeck.getId(),
                1500,
                new Progress(),
                new Lifecycle(),
                { [TutorialEngine.CREATED_DURING_TUTORIAL_KEY]: true }
            );
            sampleDeck.addCard(card);
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
}

export default TutorialSampleDeckBuilder;
