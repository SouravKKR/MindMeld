import { tutorialStepTypes } from "../Enumerations/TutorialStepTypes.js";
import DeckEvents from "../Events/DeckEvents.js";
import CardEvents from "../Events/CardEvents.js";
import TutorialSampleDeckBuilder from "../Classes/Tutorials/TutorialSampleDeckBuilder.js";
import DeckCreationChoiceAvailability from "../Classes/DeckCreationChoiceAvailability.js";
import TutorialTargetResolver from "../Classes/TutorialTargetResolver.js";

/**
 * Shared validator that gates a HIGHLIGHT step's Next button on the
 * spotlight target having a non-empty trimmed value. Works for both
 * <input>/<textarea> (.value) and contenteditable rich-text editors —
 * DeckEditor uses the former, CardEditor uses the latter.
 *
 * A <rich-text-editor> is a composite: a toolbar, the contenteditable
 * surface, and a normally-hidden raw-HTML help banner that carries real
 * text. Reading the HOST's textContent therefore always returned a
 * non-empty string, so the gate passed with an empty editor — the user
 * could click Next through "Type your question" without typing, then hit
 * an "A card must have a question" alert on Save that renders beneath
 * the tutorial overlay. Read the editable surface itself instead.
 */
const buildNonEmptyTextValidator = (selector) =>
{
    return () =>
    {
        // Resolved the same way the overlay resolves the spotlight, so the
        // gate reads the field the user is actually typing into rather than
        // a hidden namesake on another mounted page.
        const targetElement = TutorialTargetResolver.resolve(selector);
        if (!targetElement)
        {
            return false;
        }

        const editableElement = (typeof targetElement.querySelector === "function")
            ? targetElement.querySelector("[contenteditable]")
            : null;
        const valueElement = editableElement || targetElement;

        const inputValue = (typeof valueElement.value === "string")
            ? valueElement.value
            : (valueElement.textContent || "");

        return inputValue.trim().length > 0;
    };
};

/**
 * Selector for the deck tile of a deck created during the running
 * tutorial — either the sample deck the builder drops in, or the deck the
 * user makes themselves on the Beginners tour. DeckTile stamps the
 * attribute from the same CREATED_DURING_TUTORIAL_KEY flag the cleanup
 * pass uses, so this always resolves to the tutorial's own deck rather
 * than whichever tile happens to be first in the grid.
 */
const TUTORIAL_DECK_TILE_SELECTOR = "deck-tile[data-is-tutorial-sample=\"true\"]";

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
 *                    { type: WAIT_FOR_EVENT, title, body, selector, eventName }
 *                    { type: IFRAME, title, body, iframeUrl }
 *
 * Every step additionally carries `expectedPageTagName` so the engine's
 * navigation guard knows which page the step belongs on, and may carry
 * `bShouldSkipStep()` for a step that only exists on one branch of a
 * real flow (see the Beginners deck-chooser step).
 *
 * THE GOLDEN RULE for authoring steps: the tutorial must walk the SAME
 * path a real user walks. Every page change has to be caused by the user
 * clicking a real element the tour pointed at — never by a setupAction
 * calling PageNavigator — and every intermediate popup the app shows on
 * that path needs its own step. A missing intermediate step strands the
 * user on a screen the next step doesn't expect.
 */
class TutorialRegistry
{
    static BEGINNERS_ID      = "beginners";
    static HOW_TO_STUDY_ID   = "how-to-study";
    static ASK_AI_ID         = "ask-ai";
    static MOCK_TESTS_ID     = "mock-tests";
    static AI_GENERATION_ID  = "ai-generation";
    static DECK_INSIGHTS_ID  = "deck-insights";
    static PAID_LIBRARY_ID   = "paid-library";

    static #beginnersTutorial =
    {
        id: TutorialRegistry.BEGINNERS_ID,
        title: "Beginners",
        body: "A short hands-on tour of CogniumLearn — you'll create your first deck and learn the five phases of learning along the way.",
        bAutoPlayOnFirstLaunch: true,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Welcome to CogniumLearn",
                tooltipWidth: "xwide",
                expectedPageTagName: "home-page",
                body:
                `
                    <p>
                        CogniumLearn walks with you from the moment you first encounter a topic
                        all the way through finishing your exam — giving you the right tool
                        at every phase of your learning journey.
                    </p>
                    <button type="button" class="tutorial-lifecycle-diagram-zoom" aria-label="Open the lifecycle diagram fullscreen">
                        <img
                            class="tutorial-lifecycle-diagram"
                            src="./Globals/Assets/Images/Diagrams/CogniumLearnKnowledgeConsolidationLifecycleSimple.png"
                            alt="CogniumLearn Knowledge Consolidation Lifecycle"
                        >
                        <span class="tutorial-lifecycle-diagram-zoom-hint">Tap the diagram to expand</span>
                    </button>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                bWideTooltip: true,
                title: "The 5 phases of learning",
                expectedPageTagName: "home-page",
                body:
                `
                    <ol>
                        <li><strong>Acquire</strong> — capture material from any source.</li>
                        <li><strong>Encode</strong> — burn it into long-term memory.</li>
                        <li><strong>Consolidate</strong> — strengthen pathways via revision.</li>
                        <li><strong>Validate</strong> — prove what you know under exam conditions.</li>
                        <li><strong>Reflect</strong> — see exactly where you stand.</li>
                    </ol>
                    <p>Every feature in CogniumLearn serves one of these phases. Let's set up your first deck so you have somewhere to start.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                bWideTooltip: true,
                title: "What's a deck?",
                expectedPageTagName: "home-page",
                body:
                `
                    <p>In most flashcard apps a deck is just a stack of cards — questions on one side, answers on the other. That's it.</p>
                    <p>CogniumLearn's decks are different. A deck here is the <strong>home for everything you need to learn a topic</strong>:</p>
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
                type: tutorialStepTypes.MODAL,
                title: "Let's create your first deck",
                expectedPageTagName: "home-page",
                body:
                `
                    <p>Now you know what a deck is — time to make one of your own.</p>
                    <p>Click <strong>Next</strong> and we'll point out where to start.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Click the + tile",
                body: "<p>That's the New Deck tile. Click it — it's how you add anything new to your home page.</p>",
                selector: "new-deck-tile",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>If you can't see the + tile, scroll the home page to find it. We'll continue once you click it.</p>"
            },
            {
                // Only signed-in, online users get the chooser — everyone
                // else lands straight in the deck editor, so this step is
                // skipped for them rather than waiting for a button that
                // will never render.
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Choose \"Create a new deck\"",
                body:
                `
                    <p>The + tile offers three ways to get a deck: build one yourself, import a <em>.emmd</em> file, or buy a ready-made one.</p>
                    <p>Click <strong>Create a new deck</strong> to start from scratch.</p>
                `,
                selector: ".create-deck-choice-create",
                expectedPageTagName: "home-page",
                bShouldSkipStep: () => !DeckCreationChoiceAvailability.bShouldShowChoiceModal(),
                fallbackBody: "<p>Pick <strong>Create a new deck</strong> from the menu that just appeared.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Give your deck a name",
                body: "<p>This is the deck editor. Type a name for your deck in the highlighted field, then click <strong>Next</strong>.</p>",
                selector: ".deck-name-input",
                expectedPageTagName: "deck-editor-page",
                canAdvanceValidator: buildNonEmptyTextValidator(".deck-name-input"),
                fallbackBody: "<p>Type a name in the deck name field, then click Next.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Add a short name",
                body: "<p>Pick a short abbreviation for the deck — it's what the tile on your home page shows. Then click <strong>Next</strong>.</p>",
                selector: ".deck-short-name-input",
                expectedPageTagName: "deck-editor-page",
                canAdvanceValidator: buildNonEmptyTextValidator(".deck-short-name-input"),
                fallbackBody: "<p>Type a short name (any abbreviation), then click Next.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_EVENT,
                eventName: DeckEvents.UPDATE,
                title: "Save your deck",
                body:
                `
                    <p>Click <strong>Save</strong> to create the deck. You'll be taken back to your home page.</p>
                    <p>Both fields are required — Save won't go through with an empty name or short name.</p>
                `,
                selector: ".deck-save-input",
                expectedPageTagName: "deck-editor-page",
                fallbackBody: "<p>Click Save to continue. We'll wait until the deck is saved.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "This is your deck",
                body:
                `
                    <p>Nice — that's your first deck. Tapping it opens its contents; right-click (or long-press) for options.</p>
                    <p>The <strong>Study</strong> button on the tile is where the five-phase journey begins.</p>
                `,
                selector: TUTORIAL_DECK_TILE_SELECTOR,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Your deck is now on the home page. Find it whenever you want to add cards or start studying.</p>"
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "What's a card?",
                expectedPageTagName: "home-page",
                body:
                `
                    <p>A <strong>card</strong> is the atomic unit of learning — a question/answer pair tracked individually with memory scheduling and confidence-weighted mastery based on the human forgetting curve.</p>
                    <p>Inside a deck you can add cards manually, generate them with AI from your notes, or import them.</p>
                    <p>Let's add one by hand right now.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the deck options",
                body:
                `
                    <p>Click the <strong>three dots</strong> at the top-right of your deck tile.</p>
                    <p>You can also right-click the tile, or long-press it on a phone — they all open the same options menu.</p>
                `,
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .deck-options-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Open your deck's options menu (three-dots button, right-click, or long-press). We'll continue once it's open.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Click Add",
                body: "<p>Pick <strong>Add</strong> from the menu — that's how you put new content into a deck.</p>",
                selector: ".add-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Add option in the deck menu, then we'll continue.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Choose Card",
                body:
                `
                    <p>A picker just appeared. Click <strong>Card</strong> — that's the flashcard option.</p>
                    <p>(The picker also lets you add Study Materials and Mock Tests, but we'll stick with Card for the tour.)</p>
                `,
                selector: ".entity-picker-card-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Card from the picker that just appeared, then we'll continue.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Type your question",
                body: "<p>Type the question you want to be asked. Rich text, images, anything goes. Then click <strong>Next</strong>.</p>",
                selector: ".question-editor",
                expectedPageTagName: "card-editor-page",
                canAdvanceValidator: buildNonEmptyTextValidator(".question-editor"),
                fallbackBody: "<p>Type a question in the highlighted editor on the card page, then click Next.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Type the answer",
                body: "<p>Now type the answer you want to recall. Then click <strong>Next</strong>.</p>",
                selector: ".answer-editor",
                expectedPageTagName: "card-editor-page",
                canAdvanceValidator: buildNonEmptyTextValidator(".answer-editor"),
                fallbackBody: "<p>Type the answer in the highlighted editor, then click Next.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_EVENT,
                eventName: CardEvents.SAVE,
                title: "Save your card",
                body:
                `
                    <p>Click <strong>Save</strong> to create the card.</p>
                    <p>Both the question and the answer are required.</p>
                `,
                selector: ".save-button",
                expectedPageTagName: "card-editor-page",
                fallbackBody: "<p>Click Save to create the card. We'll wait for the save to go through.</p>"
            },
            {
                // Saving a NEW card deliberately leaves the editor open and
                // blank so you can add another. That means the tour has to
                // walk the user back to Home itself instead of assuming the
                // save navigated for them.
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Head back home",
                body:
                `
                    <p>Saved. Notice the editor cleared itself and stayed open — that's so you can type the next card straight away.</p>
                    <p>One card is enough for the tour. Click <strong>Back</strong> in the header to return to your home page.</p>
                `,
                selector: "header-component .back-button",
                expectedPageTagName: "card-editor-page",
                fallbackBody: "<p>Use the back button at the top of the card editor to return to your home page.</p>"
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "Study, Revise, Mock Test, Insights",
                expectedPageTagName: "home-page",
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
                type: tutorialStepTypes.MODAL,
                title: "You're ready",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                // Lazy: computing the list at class-init time would
                // try to read sibling private static fields that the
                // engine hasn't finished initialising yet.
                body: () => TutorialRegistry.#buildFinalStepBody()
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
                type: tutorialStepTypes.MODAL,
                title: "How to study with CogniumLearn",
                expectedPageTagName: "home-page",
                // Async sample-deck build runs while the user reads this
                // modal; #goNext awaits it on Next click so the next
                // step's selector always finds the freshly-built tile.
                setupAction: async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                bWideTooltip: true,
                body:
                `
                    <p>This walkthrough shows you how CogniumLearn supports the whole study journey — not just memorisation.</p>
                    <p>We've added a small <strong>sample deck</strong> to your home page so we can demo every feature on real content. The deck (and its sample cards / materials) will be removed automatically when you finish or skip the tutorial.</p>
                `
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Your sample deck",
                body: "<p>This is the sample deck we set up. It contains study materials and a few flashcards on CogniumLearn's own learning lifecycle.</p>",
                selector: TUTORIAL_DECK_TILE_SELECTOR,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Look for the new deck tile on your home page named 'Tutorial Sample Deck'.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Click Study",
                body: "<p>The <strong>Study</strong> button on the tile is where the journey begins. Click it to open the study-mode picker.</p>",
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .study-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Study button on the sample deck tile.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Pick Content Study",
                body: "<p>Choose <strong>Content Study</strong> — this is the mode for reading materials like a textbook.</p>",
                selector: ".content-study-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Content Study option in the picker.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Start the session",
                body: "<p>The sample deck has material at two detail levels, so CogniumLearn asks which you want. Keep <strong>Standard</strong> and click <strong>Start Study</strong>.</p>",
                selector: ".detail-level-picker-start",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Start Study in the detail-level picker.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Your study material",
                body: "<p>This is the study material — read it like a textbook. CogniumLearn supports rich text, images, formulas, everything.</p>",
                selector: ".study-material-content-section",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>The study material content is rendered on the page.</p>"
            },
            {
                // The assistant panel is mounted collapsed on every study
                // session. Without opening it first, the four steps below
                // would spotlight a zero-height, pointer-events:none strip.
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the Assistant",
                body: "<p>The AI helpers live in the Assistant panel, which starts hidden. Click <strong>Show Assistant</strong> at the bottom of the screen to reveal it.</p>",
                selector: ".assistant-toggle-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click <strong>Show Assistant</strong> in the study action row to reveal the AI tools.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Ask anything",
                body: "<p>Drop a question about what you're reading into this input and hit Send — the AI answers in context. Multi-line and images both work.</p>",
                selector: ".bottom-panel-question-row",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>The Ask input lives in the Assistant panel at the bottom of the study page.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Explain",
                body: "<p><strong>Explain</strong> gives you a plain-language summary of the whole material — no question needed.</p>",
                selector: ".bottom-panel-explain-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Look for the Explain button in the Assistant panel.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Summarize",
                body: "<p><strong>Summarize</strong> produces a tight cheat sheet — perfect for the night before an exam.</p>",
                selector: ".bottom-panel-summarize-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Look for the Summarize button in the Assistant panel.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Enhance",
                body: "<p><strong>Enhance</strong> applies prebuilt transformations like <em>Make mnemonic</em> or <em>Format</em>, with room for your own instructions. More tools land in this menu over time.</p>",
                selector: ".bottom-panel-enhance-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Look for the Enhance button in the Assistant panel.</p>"
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "Select text → mini menu",
                expectedPageTagName: "study-page",
                bWideTooltip: true,
                body:
                `
                    <p>If you only want help with one sentence (or paragraph) inside a card or study material, <strong>select that text</strong>. A small menu pops up over the selection with <em>Explain</em> and a free-form question input — scoped to just the part you highlighted.</p>
                    <p>Try it once the tutorial finishes — for now we'll move on to flashcards.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Back to the deck",
                body: "<p>Click <strong>Back</strong> in the header to return to your home page — we'll switch to flashcards next.</p>",
                selector: "header-component .back-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Use the back button in the header to return to Home.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open Study again",
                body: "<p>Click <strong>Study</strong> on the sample deck tile one more time — this time we'll pick Spaced Repetition.</p>",
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .study-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Study on the sample deck tile again.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Pick Spaced Repetition",
                body: "<p>Pick <strong>Spaced Repetition</strong>. This is the mode that shows each card the moment your memory of it is about to dip.</p>",
                selector: ".spaced-repetition-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Spaced Repetition in the picker.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Reveal the answer",
                body: "<p>Try to recall the answer in your head, then click <strong>Show Answer</strong> to check yourself.</p>",
                selector: ".show-answer-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click Show Answer to reveal the back of the card.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Rate your recall",
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
                selector: ".user-score-section",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Rate the card using the four feedback buttons below the answer.</p>"
            },
            {
                // Fresh study page, fresh collapsed panel — it has to be
                // reopened for the card-mode session too.
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the Assistant again",
                body: "<p>The Assistant is available on flashcards too, and it starts hidden here as well. Click <strong>Show Assistant</strong> to open it.</p>",
                selector: ".assistant-toggle-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click <strong>Show Assistant</strong> in the study action row.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Mark important cards for review",
                body: "<p>Use this toggle to mark a card for review. <strong>Revise</strong> mode plays back only marked cards — perfect for a quick polish pass right before an exam.</p>",
                selector: ".bottom-panel-mark-review-toggle",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>The Mark for Review toggle lives in the Assistant panel for card sessions.</p>"
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "Other study features",
                expectedPageTagName: "study-page",
                bWideTooltip: true,
                body:
                `
                    <ul>
                        <li><strong>Revise</strong> — fast linear pass over cards you've marked for review.</li>
                        <li><strong>Summary cheat sheet</strong> — open Content Study again and pick the <em>Summary</em> detail level for a one-page cram view.</li>
                        <li><strong>Mock Test</strong> — exam-style timed assessment. The <em>Mock tests &amp; grading</em> tutorial walks one end to end.</li>
                        <li><strong>Curated Study</strong> — auto-generated materials targeted at the topics you're weakest in. Enable <em>Auto Performance Analysis</em> + <em>Auto Generate Curated Study</em> in the deck editor and the app does the rest after a week of study.</li>
                    </ul>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Last thing — making your own decks",
                body: "<p>Click <strong>Back</strong> to return to home — we'll point out the three ways to create new decks.</p>",
                selector: "header-component .back-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Use the back button in the header to return to Home.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Create a new deck manually",
                body: "<p>Click the <strong>+</strong> tile any time to create a deck from scratch — type your own questions and answers.</p>",
                selector: "new-deck-tile",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>The + tile on the home page creates a new deck manually.</p>"
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "Two faster ways to get a deck",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                body:
                `
                    <ul>
                        <li><strong>Buy a pre-made deck</strong> — the Paid Deck Library has high-quality decks made by educators, ready to study. It's the third option behind the same + tile.</li>
                        <li><strong>Generate With AI</strong> — right-click any deck and pick "Generate With AI" to have the app build flashcards / study materials / mock tests from a syllabus, your notes, or a description.</li>
                    </ul>
                    <p>You don't have to choose just one — most users mix all three.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "You're set",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                // Lazy: computing the list at class-init time would
                // try to read sibling private static fields that the
                // engine hasn't finished initialising yet.
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #askAiTutorial =
    {
        id: TutorialRegistry.ASK_AI_ID,
        title: "Ask AI while you study",
        body: "See how Explain, Summarize, Enhance and Ask help you while reading — shown with built-in sample responses, so the tutorial makes no real AI calls.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Ask AI while you study",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                setupAction: async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                body:
                `
                    <p>While you're studying, the AI can <strong>explain</strong>, <strong>summarize</strong>, <strong>enhance</strong> or <strong>answer a question</strong> about what you're reading — right from the Assistant panel.</p>
                    <p>Let's open a study session on the sample deck and try it. The responses in this tutorial are <strong>built-in samples</strong> — no real AI call is made. (The real AI features use credits.)</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open Study",
                body: "<p>Click <strong>Study</strong> on the sample deck tile.</p>",
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .study-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Study button on the sample deck tile.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Pick Content Study",
                body:
                `
                    <p>Choose <strong>Content Study</strong> — the mode for reading materials.</p>
                    <p>The AI helpers we're about to use also work in <strong>Spaced Repetition</strong> and <strong>Revise</strong> (the other modes in this popup) — Content Study is just what we'll demo here.</p>
                `,
                selector: ".content-study-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Content Study option in the picker.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Start the session",
                body: "<p>Pick a detail level and click <strong>Start Study</strong> to open the material.</p>",
                selector: ".detail-level-picker-start",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Start Study in the detail-level picker.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the Assistant",
                body: "<p>The AI tools live in the Assistant panel, which starts hidden. Click <strong>Show Assistant</strong> at the bottom to reveal it.</p>",
                selector: ".assistant-toggle-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click <strong>Show Assistant</strong> in the study action row to reveal the AI tools.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Try Explain",
                body:
                `
                    <p>Click <strong>Explain</strong> in the Assistant panel. The answer that appears is a <strong>built-in sample</strong> — during a tutorial the AI buttons show sample responses instead of making a real call.</p>
                `,
                selector: ".bottom-panel-explain-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click the Explain button in the Assistant panel.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "What an AI response looks like",
                expectedPageTagName: "study-page",
                selector: ".ask-ai-dialog",
                fallbackBody: "<p>The AI response popup is open in front of you. Read it, then click Next.</p>",
                body:
                `
                    <p>This is exactly what an AI answer looks like, rendered through the real popup — but it's a <strong>built-in sample</strong>, not a live AI call.</p>
                    <p>Read it, then click <strong>Next</strong> — we'll close the popup for you.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "Summarize, Enhance and Ask",
                expectedPageTagName: "study-page",
                bWideTooltip: true,
                // Close the sample response popup so the next steps aren't
                // read through a dialog the user has to dismiss themselves.
                setupAction: async () =>
                {
                    TutorialRegistry.#closeAskAiDialogIfOpen();
                },
                body:
                `
                    <p><strong>Summarize</strong> makes a cheat sheet, <strong>Enhance</strong> applies tools like "Make mnemonic", and the <strong>Ask</strong> input answers your own question — all on what you're studying.</p>
                    <p>They work exactly like Explain, and the same helpers appear in <strong>Spaced Repetition</strong> and <strong>Revise</strong> too. In this tutorial they all show built-in samples instead of making real calls.</p>
                `
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Select text → mini menu",
                expectedPageTagName: "study-page",
                // Belt-and-braces: the user may have re-opened a response
                // from the previous step's buttons.
                setupAction: async () =>
                {
                    TutorialRegistry.#closeAskAiDialogIfOpen();
                },
                selector: ".study-material-content-section",
                fallbackBody: "<p>Select any text in the material — a small Explain / Ask menu pops up over your selection. Then click Next.</p>",
                body:
                `
                    <p>You can also scope the AI to just part of what you're reading. In the material, find the <strong>Encode</strong> section and select the words <strong>"Spaced Repetition"</strong> — a small menu pops up over your selection with <strong>Explain</strong> and an <strong>Ask</strong> box, scoped to just that text.</p>
                    <p>Click <strong>Explain</strong> in that menu to see the sample response, then click <strong>Next</strong>. (It's a built-in sample, like the rest of this tutorial.)</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "That's Ask AI",
                expectedPageTagName: "study-page",
                bWideTooltip: true,
                setupAction: async () =>
                {
                    TutorialRegistry.#closeAskAiDialogIfOpen();
                },
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #mockTestsTutorial =
    {
        id: TutorialRegistry.MOCK_TESTS_ID,
        title: "Mock tests & grading",
        body: "Take the sample deck's mock test from start to finish — launch it, answer a question, finish, and see it graded — all offline with a built-in sample, so no real grading runs and no credits are spent.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Mock tests & grading",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                setupAction: async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                body:
                `
                    <p>CogniumLearn grades your mock tests — multiple-choice questions instantly and offline, subjective answers with AI. Let's take the sample deck's mock test <strong>end to end</strong>: launch it, answer a question, finish, and see the graded answer key.</p>
                    <p>Everything in this tutorial runs offline on your device — no real grading and no credits spent.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open Study",
                body: "<p>Click <strong>Study</strong> on the sample deck tile to open the study-mode picker.</p>",
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .study-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Study button on the sample deck tile.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Pick Mock Test",
                body: "<p>Choose <strong>Mock Test</strong> — the exam-style assessment mode.</p>",
                selector: ".mock-test-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Mock Test option in the study-mode picker.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Take the test",
                body: "<p>This is the mock-test picker — every test in the deck is listed here. Click <strong>Take Test</strong> on the sample test.</p>",
                selector: ".mock-test-picker-take-test-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Take Test on the sample mock test card.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Start the test",
                body:
                `
                    <p>Choose <strong>Online</strong> (answer on screen) or <strong>Offline</strong> (write on paper, upload scans), set a duration, then click <strong>Start Test</strong>.</p>
                    <p>We'll keep the defaults — Online — for this demo.</p>
                `,
                selector: ".mock-test-start-start-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click Start Test in the start dialog.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Answer the questions",
                expectedPageTagName: "study-page",
                selector: ".mock-test-runner-items-container",
                fallbackBody: "<p>Answer the questions in the runner — tick an option for each.</p>",
                body:
                `
                    <p>This is the test runner. A timer counts down in the header, and you answer each question inline — tick an option for these multiple-choice questions. Go ahead and pick an answer, then click <strong>Next</strong>.</p>
                    <p>(Multiple-choice questions are graded instantly and offline; subjective answers are graded by AI on a real run.)</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Finish the test",
                body:
                `
                    <p>When you're done, click <strong>Finish Test</strong>. In this tutorial your attempt is graded <strong>instantly and offline</strong> — no server call, no credits — and you'll land straight on the answer key.</p>
                `,
                selector: ".mock-test-runner-finish-button",
                expectedPageTagName: "study-page",
                fallbackBody: "<p>Click Finish Test in the runner header.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Your graded answer key",
                expectedPageTagName: "mock-test-answer-key-page",
                selector: ".mock-test-answer-key-page-body",
                fallbackBody: "<p>This is the graded answer key for your attempt.</p>",
                body:
                `
                    <p>Here's your graded result. Each question shows <strong>your answer</strong>, the <strong>expected answer</strong>, the <strong>score</strong> and — where relevant — an <strong>examiner's note</strong>. Your total score is at the top.</p>
                    <p>This was graded entirely on your device — no grading server was called.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "That's mock-test grading",
                expectedPageTagName: "mock-test-answer-key-page",
                bWideTooltip: true,
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #aiGenerationTutorial =
    {
        id: TutorialRegistry.AI_GENERATION_ID,
        title: "Generate decks with AI",
        body: "Walk the real Generate-With-AI route from your home page and watch CogniumLearn build a deck — played as a built-in sample run, so the tutorial doesn't start a real generation.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Generate decks with AI",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                setupAction: async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                body:
                `
                    <p>CogniumLearn can build a whole deck — flashcards, study materials and mock tests — from a syllabus, your notes, a PDF or a web link.</p>
                    <p>We've put a <strong>sample deck</strong> on your home page to generate into. We'll take the same route you would on a real deck — the run itself is a <strong>built-in sample</strong>, so no generation is started and no credits are spent.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the deck options",
                body:
                `
                    <p>Generation always starts from a deck. Click the <strong>three dots</strong> at the top-right of the sample deck tile.</p>
                    <p>Right-click or long-press the tile does the same thing.</p>
                `,
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .deck-options-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Open the sample deck's options menu (three-dots button, right-click, or long-press).</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Click Generate With AI",
                body: "<p>Pick <strong>Generate With AI</strong> from the menu — that opens the generation form for this deck.</p>",
                selector: ".generate-with-ai-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Generate With AI option in the deck menu.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Start the generation",
                expectedPageTagName: "automatic-generation-page",
                selector: ".automatic-generation-start-button",
                fallbackBody: "<p>Find the <strong>Start Generation</strong> button at the bottom of the page.</p>",
                body:
                `
                    <p>This is the generation form — on a real run you'd describe your subject and attach a syllabus, notes or a PDF, and pick what to generate.</p>
                    <p>Click <strong>Start Generation</strong>. In this tutorial it skips the form and plays a built-in sample run — it doesn't start a real generation.</p>
                `
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Generation in progress",
                expectedPageTagName: "progress-page",
                selector: "generation-progress-component",
                fallbackBody: "<p>The generation pipeline is running here.</p>",
                body:
                `
                    <p>Watch the pipeline climb to completion. On a real run this is where the work happens and credits are spent — here it's a built-in sample played on your device. When it finishes, click <strong>Next</strong>.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "That's AI generation",
                expectedPageTagName: "progress-page",
                bWideTooltip: true,
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #deckInsightsTutorial =
    {
        id: TutorialRegistry.DECK_INSIGHTS_ID,
        title: "Understand your progress",
        body: "See how Deck Insights groups your topics into strong, weak and confused — shown on a sample deck so you know what to study next.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Understand your progress",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                setupAction: async () =>
                {
                    await TutorialSampleDeckBuilder.createForUser();
                },
                body:
                `
                    <p>Deck Insights shows you exactly where you stand on a deck. Click <strong>Next</strong> and we'll open it on a sample deck together — the same way you would on any of your own decks.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open the deck options",
                body:
                `
                    <p>Click the <strong>three dots</strong> at the top-right of the sample deck tile.</p>
                    <p>You can also right-click the tile, or long-press it on a phone — they all open the same options menu.</p>
                `,
                selector: `${TUTORIAL_DECK_TILE_SELECTOR} .deck-options-button`,
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Open the sample deck's options menu (three-dots button, right-click, or long-press). We'll continue once it's open.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open Insights",
                body: "<p>Pick <strong>Insights</strong> from the menu — that opens Deck Insights for this deck.</p>",
                selector: ".insights-button",
                expectedPageTagName: "home-page",
                fallbackBody: "<p>Click the Insights option in the deck menu, then we'll continue.</p>"
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Strong, weak & confused topics",
                expectedPageTagName: "deck-insights-page",
                selector: "topic-insights",
                fallbackBody: "<p>The topic breakdown is shown on this page.</p>",
                body:
                `
                    <p>Topics are grouped into <strong>strong</strong>, <strong>weak</strong> and <strong>confused</strong> so you know exactly what to study next. (These are seeded for the demo — your real decks fill this in automatically as you study, with no action needed.)</p>
                `
            },
            {
                type: tutorialStepTypes.HIGHLIGHT,
                title: "Refresh your insights on demand",
                expectedPageTagName: "deck-insights-page",
                selector: ".topic-insights-run-button",
                fallbackBody: "<p>The <strong>Clear &amp; Re-analyse</strong> button at the top of Topic Insights re-runs the AI analysis to refresh these topics.</p>",
                body:
                `
                    <p><strong>Clear &amp; Re-analyse</strong> re-runs the AI analysis on demand: it clears the current breakdown and regenerates your strong / weak / confused topics from your latest study activity. CogniumLearn normally does this for you automatically after about a week of studying — this button is the manual override for when you want a fresh read right now.</p>
                    <p>Try clicking it. During this tutorial it plays a <strong>demo run</strong> — you'll see the progress and the same topics reappear, but no real analysis is queued and no credits are spent. Click <strong>Next</strong> when you're done.</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "That's Deck Insights",
                expectedPageTagName: "deck-insights-page",
                bWideTooltip: true,
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    static #paidLibraryTutorial =
    {
        id: TutorialRegistry.PAID_LIBRARY_ID,
        title: "Buy a ready-made deck",
        body: "Walk through the real flow for getting a ready-made deck — from the + tile on your home page to the storefront — using a sample listing and a demo checkout that makes no real purchase.",
        bAutoPlayOnFirstLaunch: false,
        steps:
        [
            {
                type: tutorialStepTypes.MODAL,
                title: "Buy a ready-made deck",
                expectedPageTagName: "home-page",
                bWideTooltip: true,
                body:
                `
                    <p>The <strong>Paid Deck Library</strong> has ready-made decks built by educators — a fast alternative to building your own. You reach it the same way you create a deck: from the <strong>+</strong> tile on your home page. Let's walk through it.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Click the + tile",
                expectedPageTagName: "home-page",
                selector: "new-deck-tile",
                fallbackBody: "<p>Click the <strong>+</strong> tile on your home page.</p>",
                body: "<p>Click the <strong>+</strong> tile on your home page — it's how you add a deck.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Choose Browse paid decks",
                expectedPageTagName: "home-page",
                selector: ".create-deck-choice-buy",
                fallbackBody: "<p>Pick <strong>Browse paid decks</strong> from the menu.</p>",
                body: "<p>The menu offers three ways to add a deck. Pick <strong>Browse paid decks</strong> to open the storefront.</p>"
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Open a listing",
                expectedPageTagName: "paid-deck-library-page",
                selector: ".paid-deck-card-view",
                fallbackBody: "<p>Click <strong>View details</strong> on the sample deck card.</p>",
                body:
                `
                    <p>Here's a sample listing — the real library lets you search, filter and sort decks by educators. Click <strong>View details</strong> to open this one.</p>
                `
            },
            {
                type: tutorialStepTypes.WAIT_FOR_CLICK,
                title: "Buy the deck",
                expectedPageTagName: "paid-deck-details-page",
                selector: ".paid-deck-details-cta",
                fallbackBody: "<p>Click the <strong>Buy</strong> button.</p>",
                body:
                `
                    <p>The details page shows what's inside. Click <strong>Buy</strong> — in this tutorial <strong>no real purchase is made</strong> and no payment is taken; a sample copy is just added to your home page. (A real purchase uses a secure checkout.)</p>
                `
            },
            {
                type: tutorialStepTypes.MODAL,
                title: "That's the Paid Deck Library",
                expectedPageTagName: "paid-deck-details-page",
                bWideTooltip: true,
                body: () => TutorialRegistry.#buildFinalStepBody()
            }
        ]
    };

    /**
     * Dismisses the Ask-AI sample response popup if one is open. Used by
     * the Ask-AI tour so the user isn't left reading later steps through
     * a dialog they have to close themselves.
     */
    static #closeAskAiDialogIfOpen()
    {
        const askAiHostElement = document.querySelector(".ask-ai-dialog");
        const dialogBoxElement = askAiHostElement ? askAiHostElement.closest("dialog-box") : null;

        if (!dialogBoxElement)
        {
            return;
        }

        if (typeof dialogBoxElement.close === "function")
        {
            dialogBoxElement.close();
        }
        else
        {
            dialogBoxElement.remove();
        }
    }

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
            <p>Click <strong>Finish</strong>. Anything created just for this tour is cleared automatically.</p>
        `;
    }

    /**
     * @returns {object[]} all registered tutorials in display order.
     */
    static getAll()
    {
        return [
            TutorialRegistry.#beginnersTutorial,
            TutorialRegistry.#howToStudyTutorial,
            TutorialRegistry.#askAiTutorial,
            TutorialRegistry.#mockTestsTutorial,
            TutorialRegistry.#aiGenerationTutorial,
            TutorialRegistry.#deckInsightsTutorial,
            TutorialRegistry.#paidLibraryTutorial
        ];
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
