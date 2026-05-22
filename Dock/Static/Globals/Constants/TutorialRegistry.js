import { tutorialStepTypes } from "../Enumerations/TutorialStepTypes.js";
import DeckEvents from "../Events/DeckEvents.js";
import CardEvents from "../Events/CardEvents.js";
import TutorialSampleDeckBuilder from "../Classes/Tutorials/TutorialSampleDeckBuilder.js";

/**
 * Shared validator that gates a HIGHLIGHT step's Next button on the
 * spotlight target having a non-empty trimmed value. Works for both
 * <input>/<textarea> (.value) and contenteditable rich-text editors
 * (.textContent) — DeckEditor uses the former, CardEditor uses the
 * latter.
 */
const buildNonEmptyTextValidator = (selector) =>
{
    return () =>
    {
        const targetElement = document.querySelector(selector);
        if (!targetElement)
        {
            return false;
        }
        const inputValue = (typeof targetElement.value === "string" && targetElement.value.length > 0)
            ? targetElement.value
            : (targetElement.textContent || "");
        return inputValue.trim().length > 0;
    };
};

/**
 * TutorialRegistry
 *
 * Single source of truth for every interactive tutorial the app ships
 * with. Each tutorial has:
 *   - id           : stable string used by the completion tracker and the
 *                    tutorials listing page
 *   - title / body : copy shown on the tutorials listing
 *   - bAutoPlayOnFirstLaunch : true means the tutorial fires automatically
 *                    on the user's first device launch
 *   - steps        : ordered array of step definitions consumed by
 *                    TutorialEngine. Each step is one of:
 *                    { type: MODAL, title, body, bWideTooltip? }
 *                    { type: HIGHLIGHT, title, body, selector, fallbackBody? }
 *                    { type: WAIT_FOR_CLICK, title, body, selector, fallbackBody? }
 *                    { type: IFRAME, title, body, iframeUrl }
 *
 * The Beginners tour is designed to work on a brand-new, completely
 * blank account: every interactive step targets an element that always
 * exists for new users (`new-deck-tile`, `.deck-save-input`), and the
 * user actually performs the actions themselves rather than being
 * shown static highlights.
 */
class TutorialRegistry
{
    static BEGINNERS_ID      = "beginners";
    static HOW_TO_STUDY_ID   = "how-to-study";

    static #beginnersTutorial =
    {
        id: TutorialRegistry.BEGINNERS_ID,
        title: "Beginners",
        body: "A short hands-on tour of MindMeld — you'll create your first deck and learn the five phases of learning along the way.",
        bAutoPlayOnFirstLaunch: true,
        steps:
        [
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Welcome to MindMeld",
                tooltipWidth:         "xwide",
                expectedPageTagName:  "home-page",
                body:
                `
                    <p>
                        MindMeld walks with you from the moment you first encounter a topic
                        all the way through finishing your exam — giving you the right tool
                        at every phase of your learning journey.
                    </p>
                    <button type="button" class="tutorial-lifecycle-diagram-zoom" aria-label="Open the lifecycle diagram fullscreen">
                        <img
                            class="tutorial-lifecycle-diagram"
                            src="./Globals/Assets/Images/Diagrams/MindMeldKnowledgeConsolidationLifecycle.png"
                            alt="MindMeld Knowledge Consolidation Lifecycle"
                        >
                        <span class="tutorial-lifecycle-diagram-zoom-hint">Tap the diagram to expand</span>
                    </button>
                `
            },
            {
                type:                 tutorialStepTypes.MODAL,
                bWideTooltip:         true,
                title:                "The 5 phases of learning",
                expectedPageTagName:  "home-page",
                body:
                `
                    <ol>
                        <li><strong>Acquire</strong> — capture material from any source.</li>
                        <li><strong>Encode</strong> — burn it into long-term memory.</li>
                        <li><strong>Consolidate</strong> — strengthen pathways via revision.</li>
                        <li><strong>Validate</strong> — prove what you know under exam conditions.</li>
                        <li><strong>Reflect</strong> — see exactly where you stand.</li>
                    </ol>
                    <p>Every feature in MindMeld serves one of these phases. Let's set up your first deck so you have somewhere to start.</p>
                `
            },
            {
                type:                 tutorialStepTypes.MODAL,
                bWideTooltip:         true,
                title:                "What's a deck?",
                expectedPageTagName:  "home-page",
                body:
                `
                    <p>In most flashcard apps a deck is just a stack of cards — questions on one side, answers on the other. That's it.</p>
                    <p>MindMeld's decks are different. A deck here is the <strong>home for everything you need to learn a topic</strong>:</p>
                    <ul>
                        <li><strong>Flashcards</strong> — for spaced repetition and recall practice.</li>
                        <li><strong>Study materials</strong> — your notes, summaries, PDFs and source documents, all in one place.</li>
                        <li><strong>Mock tests</strong> — exam-style assessments to validate what you know.</li>
                        <li><strong>Sub-decks</strong> — nest decks inside decks to mirror the structure of your syllabus.</li>
                    </ul>
                    <p>It's the unit that carries you through all five phases of learning — not just memorisation.</p>
                `
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Let's create your first deck",
                expectedPageTagName:  "home-page",
                body:
                `
                    <p>Now you know what a deck is — time to make one of your own.</p>
                    <p>Click <strong>Next</strong> and we'll point out where to start.</p>
                `
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Click the + tile",
                body:                 "<p>That's the New Deck tile. Click it to open the deck editor.</p>",
                selector:             "new-deck-tile",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>If you can't see the + tile, scroll the home page to find it. We'll continue once you click it.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Give your deck a name",
                body:                 "<p>Type a name for your deck in the highlighted field, then click <strong>Next</strong>.</p>",
                selector:             ".deck-name-input",
                expectedPageTagName:  "deck-editor-page",
                canAdvanceValidator:  buildNonEmptyTextValidator(".deck-name-input"),
                fallbackBody:         "<p>Type a name in the deck name field, then click Next.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Add a short name",
                body:                 "<p>Pick a short abbreviation for the deck — anything works. Then click <strong>Next</strong>.</p>",
                selector:             ".deck-short-name-input",
                expectedPageTagName:  "deck-editor-page",
                canAdvanceValidator:  buildNonEmptyTextValidator(".deck-short-name-input"),
                fallbackBody:         "<p>Type a short name (any abbreviation), then click Next.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_EVENT,
                eventName:            DeckEvents.UPDATE,
                title:                "Save your deck",
                body:
                `
                    <p>Click <strong>Save</strong> to create the deck.</p>
                    <p>Both fields are required — Save won't go through with an empty name or short name.</p>
                `,
                selector:             ".deck-save-input",
                expectedPageTagName:  "deck-editor-page",
                fallbackBody:         "<p>Click Save to continue. We'll wait until the deck is saved.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "This is your deck",
                body:
                `
                    <p>Nice — that's your first deck. Tapping it opens its contents; right-click (or long-press) for options.</p>
                    <p>The <strong>Study</strong> button on the tile is where the five-phase journey begins.</p>
                `,
                selector:             "deck-tile",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Your deck is now on the home page. Find it whenever you want to add cards or start studying.</p>"
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "What's a card?",
                expectedPageTagName:  "home-page",
                body:
                `
                    <p>A <strong>card</strong> is the atomic unit of learning — a question/answer pair tracked individually with memory scheduling and confidence-weighted mastery based on the human forgetting curve.</p>
                    <p>Inside a deck you can add cards manually, generate them with AI from your notes, or import them.</p>
                    <p>Let's add one by hand right now.</p>
                `
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Open the deck options",
                body:
                `
                    <p>Click the <strong>three dots</strong> at the top-right of your deck tile.</p>
                    <p>You can also right-click the tile, or long-press it on a phone — they all open the same options menu.</p>
                `,
                selector:             ".deck-options-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Open your deck's options menu (three-dots button, right-click, or long-press). We'll continue once it's open.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Click Add",
                body:                 "<p>Pick <strong>Add</strong> from the menu — that's how you put new content into a deck.</p>",
                selector:             ".add-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click the Add option in the deck menu, then we'll continue.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Choose Card",
                body:
                `
                    <p>A picker just appeared. Click <strong>Card</strong> — that's the flashcard option.</p>
                    <p>(The picker also lets you add Study Materials and Mock Tests, but we'll stick with Card for the tour.)</p>
                `,
                selector:             ".entity-picker-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click Card from the picker that just appeared, then we'll continue.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Type your question",
                body:                 "<p>Type the question you want to be asked. Rich text, images, anything goes. Then click <strong>Next</strong>.</p>",
                selector:             ".question-editor",
                expectedPageTagName:  "card-editor-page",
                canAdvanceValidator:  buildNonEmptyTextValidator(".question-editor"),
                fallbackBody:         "<p>Type a question in the highlighted editor on the card page, then click Next.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Type the answer",
                body:                 "<p>Now type the answer you want to recall. Then click <strong>Next</strong>.</p>",
                selector:             ".answer-editor",
                expectedPageTagName:  "card-editor-page",
                canAdvanceValidator:  buildNonEmptyTextValidator(".answer-editor"),
                fallbackBody:         "<p>Type the answer in the highlighted editor, then click Next.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_EVENT,
                eventName:            CardEvents.SAVE,
                title:                "Save your card",
                body:
                `
                    <p>Click <strong>Save</strong> to create the card. The editor stays open so you can add more — but for now, just one is enough.</p>
                    <p>Both the question and the answer are required.</p>
                `,
                selector:             ".save-button",
                expectedPageTagName:  "card-editor-page",
                fallbackBody:         "<p>Click Save to create the card. We'll wait for the save to go through.</p>"
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Study, Revise, Mock Test, Insights",
                expectedPageTagName:  "home-page",
                body:
                `
                    <ul>
                        <li><strong>Spaced Repetition / Content Study</strong> — the Encode phase.</li>
                        <li><strong>Revise</strong> — the Consolidate phase.</li>
                        <li><strong>Mock Test</strong> — the Validate phase.</li>
                        <li><strong>Deck Insights</strong> — the Reflect phase.</li>
                    </ul>
                    <p>All four live on each deck. Try them once you have a card or two.</p>
                `
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "You're ready",
                expectedPageTagName:  "home-page",
                bWideTooltip:         true,
                // Lazy: computing the list at class-init time would
                // try to read sibling private static fields that the
                // engine hasn't finished initialising yet.
                body:                 () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #howToStudyTutorial =
    {
        id: TutorialRegistry.HOW_TO_STUDY_ID,
        title: "How to Study",
        body: "A guided walkthrough of every study mode using a sample deck we'll create for you — and clean up automatically when you're done.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "How to study with MindMeld",
                expectedPageTagName:  "home-page",
                // Async sample-deck build runs while the user reads this
                // modal; #goNext awaits it on Next click so the next
                // step's selector always finds the freshly-built tile.
                setupAction:          async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                bWideTooltip:         true,
                body:
                `
                    <p>This walkthrough shows you how MindMeld supports the whole study journey — not just memorisation.</p>
                    <p>We've added a small <strong>sample deck</strong> to your home page so we can demo every feature on real content. The deck (and its sample cards / materials) will be removed automatically when you finish or skip the tutorial.</p>
                `
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Your sample deck",
                body:                 "<p>This is the sample deck we set up. It contains a study material and a few flashcards on MindMeld's own learning lifecycle.</p>",
                selector:             "deck-tile[data-is-tutorial-sample=\"true\"]",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Look for the new deck tile on your home page named 'Tutorial Sample Deck'.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Start studying",
                body:                 "<p>The <strong>Study</strong> button on the tile is where the journey begins. We'll start with reading the study material.</p>",
                selector:             "deck-tile[data-is-tutorial-sample=\"true\"] .study-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Find the <strong>Study</strong> button on the sample deck tile.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Click Study",
                body:                 "<p>Click <strong>Study</strong> to open the study-mode picker.</p>",
                selector:             "deck-tile[data-is-tutorial-sample=\"true\"] .study-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click the Study button on the sample deck tile.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Pick Content Study",
                body:                 "<p>Choose <strong>Content Study</strong> — this is the mode for reading materials like a textbook.</p>",
                selector:             ".content-study-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click the Content Study option in the picker.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Start the session",
                body:                 "<p>Pick a detail level — Standard is what we'll demo — and click <strong>Start Study</strong>.</p>",
                selector:             ".detail-level-picker-start",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click Start Study in the detail-level picker.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Your study material",
                body:                 "<p>This is the study material — read it like a textbook. MindMeld supports rich text, images, formulas, everything.</p>",
                selector:             ".study-material-content-section",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>The study material content is rendered on the page.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Ask anything",
                body:                 "<p>Drop a question about what you're reading into this input and hit Send — the AI answers in context. Multi-line and images both work.</p>",
                selector:             ".bottom-panel-question-row",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>The Ask input lives in the bottom panel of the study page.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Explain",
                body:                 "<p><strong>Explain</strong> gives you a plain-language summary of the whole material — no question needed.</p>",
                selector:             ".bottom-panel-explain-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Look for the Explain button in the bottom panel.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Summarize",
                body:                 "<p><strong>Summarize</strong> produces a tight cheat sheet — perfect for the night before an exam.</p>",
                selector:             ".bottom-panel-summarize-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Look for the Summarize button in the bottom panel.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Enhance",
                body:                 "<p><strong>Enhance</strong> applies prebuilt transformations like <em>Make mnemonic</em> or <em>Format</em>, with room for your own instructions. More tools land in this menu over time.</p>",
                selector:             ".bottom-panel-enhance-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Look for the Enhance button in the bottom panel.</p>"
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Select text → mini menu",
                expectedPageTagName:  "study-page",
                bWideTooltip:         true,
                body:
                `
                    <p>If you only want help with one sentence (or paragraph) inside a card or study material, <strong>select that text</strong>. A small menu pops up over the selection with <em>Explain</em> and a free-form question input — scoped to just the part you highlighted.</p>
                    <p>Try it once the tutorial finishes — for now we'll move on to flashcards.</p>
                `
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Back to the deck",
                body:                 "<p>Click <strong>Back</strong> in the header to return to your home page — we'll switch to flashcards next.</p>",
                selector:             "header-component .back-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Use the back button in the header to return to Home.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Open Study again",
                body:                 "<p>Click <strong>Study</strong> on the sample deck tile one more time — this time we'll pick Spaced Repetition.</p>",
                selector:             "deck-tile[data-is-tutorial-sample=\"true\"] .study-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click Study on the sample deck tile again.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Pick Spaced Repetition",
                body:                 "<p>Pick <strong>Spaced Repetition</strong>. This is the FSRS-driven mode that shows each card the moment your memory of it is about to dip.</p>",
                selector:             ".spaced-repetition-button",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>Click Spaced Repetition in the picker.</p>"
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Reveal the answer",
                body:                 "<p>Try to recall the answer in your head, then click <strong>Show Answer</strong> to check yourself.</p>",
                selector:             ".show-answer-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Click Show Answer to reveal the back of the card.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Rate your recall",
                body:
                `
                    <p>Honest feedback drives the schedule. The four buttons mean:</p>
                    <ul>
                        <li><strong>Very Hard</strong> — couldn't recall it. Card comes back fast.</li>
                        <li><strong>Hard</strong> — partial recall. Slightly stretched interval.</li>
                        <li><strong>Medium</strong> — got it with effort. Standard schedule.</li>
                        <li><strong>Easy</strong> — instant recall. Interval stretches further out.</li>
                    </ul>
                `,
                selector:             ".user-score-section",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Rate the card using the four feedback buttons below the answer.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Mark important cards for review",
                body:                 "<p>Use this toggle to mark a card for review. <strong>Revise</strong> mode plays back only marked cards — perfect for a quick polish pass right before an exam.</p>",
                selector:             ".bottom-panel-mark-review-toggle",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>The Mark for Review toggle lives in the bottom panel for card sessions.</p>"
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Other study features",
                expectedPageTagName:  "study-page",
                bWideTooltip:         true,
                body:
                `
                    <ul>
                        <li><strong>Revise</strong> — fast linear pass over cards you've marked for review.</li>
                        <li><strong>Summary cheat sheet</strong> — open Content Study again and pick the <em>Summary</em> detail level for a one-page cram view.</li>
                        <li><strong>Mock Test</strong> — exam-style timed assessment (coming soon).</li>
                        <li><strong>Curated Study</strong> — auto-generated materials targeted at the topics you're weakest in. Enable <em>Auto Performance Analysis</em> + <em>Auto Generate Curated Study</em> in the deck editor and the app does the rest after a week of study.</li>
                    </ul>
                `
                // TODO: Wire up a mock-test walkthrough segment here once
                // the timed MockTestSession UI ships. As soon as
                // MockTestSession.start() can render a non-PDF in-page
                // quiz, add WAIT_FOR_CLICK + HIGHLIGHT steps for the
                // Start, Submit, and per-question score reveal — the
                // sample deck already contains the cards needed for it.
            },
            {
                type:                 tutorialStepTypes.WAIT_FOR_CLICK,
                title:                "Last thing — making your own decks",
                body:                 "<p>Click <strong>Back</strong> to return to home — we'll point out the three ways to create new decks.</p>",
                selector:             "header-component .back-button",
                expectedPageTagName:  "study-page",
                fallbackBody:         "<p>Use the back button in the header to return to Home.</p>"
            },
            {
                type:                 tutorialStepTypes.HIGHLIGHT,
                title:                "Create a new deck manually",
                body:                 "<p>Click the <strong>+</strong> tile any time to create a deck from scratch — type your own questions and answers.</p>",
                selector:             "new-deck-tile",
                expectedPageTagName:  "home-page",
                fallbackBody:         "<p>The + tile on the home page creates a new deck manually.</p>"
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "Two faster ways to get a deck",
                expectedPageTagName:  "home-page",
                bWideTooltip:         true,
                body:
                `
                    <ul>
                        <li><strong>Buy a pre-made deck</strong> — the Paid Deck Library has high-quality decks made by educators, ready to study.</li>
                        <li><strong>Generate With AI</strong> — right-click any deck and pick "Generate With AI" to have the app build flashcards / study materials / mock tests from a syllabus, your notes, or a description. (Currently restricted to admins during the beta.)</li>
                    </ul>
                    <p>You don't have to choose just one — most users mix all three.</p>
                `
            },
            {
                type:                 tutorialStepTypes.MODAL,
                title:                "You're set",
                expectedPageTagName:  "home-page",
                bWideTooltip:         true,
                // Lazy: computing the list at class-init time would
                // try to read sibling private static fields that the
                // engine hasn't finished initialising yet.
                body:                 () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    /**
     * Renders the body of the final "You're ready" modal. Lists every
     * tutorial currently in the registry so the user discovers other
     * tours that may have been added since they last opened the app —
     * the list auto-updates when new tutorials are registered, no copy
     * tweak required.
     */
    static #buildFinalStepBody()
    {
        const tutorialListItems = TutorialRegistry.getAll()
            .map(tutorial => `<li><strong>${tutorial.title}</strong> — ${tutorial.body}</li>`)
            .join("");

        return `
            <p>That's the whirlwind tour. Open the sidebar (☰) and click <strong>Tutorial</strong> any time to retake this — or any other tutorial we've added.</p>
            <p>Available tutorials right now:</p>
            <ul>${tutorialListItems}</ul>
            <p>Click <strong>Finish</strong>. On the next screen you can choose to clear anything you created during this tour, or keep it.</p>
        `;
    }

    /**
     * @returns {object[]} all registered tutorials in display order.
     */
    static getAll()
    {
        return [TutorialRegistry.#beginnersTutorial, TutorialRegistry.#howToStudyTutorial];
    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    static getById(id)
    {
        return TutorialRegistry.getAll().find(tutorial => tutorial.id === id) || null;
    }

    /**
     * @returns {object[]} tutorials flagged to auto-play on first device launch.
     */
    static getAutoPlayOnFirstLaunch()
    {
        return TutorialRegistry.getAll().filter(tutorial => tutorial.bAutoPlayOnFirstLaunch);
    }
}

export default TutorialRegistry;
