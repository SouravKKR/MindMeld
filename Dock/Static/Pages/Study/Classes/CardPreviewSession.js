import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";
import CuratedFlashcardFields from "../../../Globals/Classes/Analysis/CuratedFlashcardFields.js";

/**
 * CardPreviewSession
 *
 * Read-only walk-through of a deck's cards, opened from the Browser's
 * per-card "Preview" action. It mirrors ReviseSession's free Previous/Next
 * navigation and answer reveal, but deliberately never calls Card.attempt()
 * or Card.view() — previewing a card records NOTHING into FSRS / Glicko /
 * the lifecycle counters. The user can flip through every card in the
 * browsed deck (curated cards excluded, matching the Browser list) starting
 * at the one they clicked.
 */
class CardPreviewSession extends StudySession
{
    #cards = [];
    #index = 0;
    #startIndex = 0;

    /**
     * @param {StudyPage} studyPage
     * @param {Deck} deck - The deck currently shown in the Browser.
     * @param {Card} startCard - The card whose Preview action was clicked.
     */
    constructor(studyPage, deck = null, startCard = null)
    {
        super(studyPage, deck);

        // getCards(true) recurses into sub-decks and already excludes curated
        // cards by default, so this is the exact set the Browser lists. The
        // explicit curated filter is defence in depth.
        this.#cards = deck.getCards(true).filter((card) => card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] !== true);

        if(this.#cards.length === 0)
        {
            PageNavigator.back();
            DialogBox.alert("Note", "There are no cards to preview in this deck.");
            return;
        }

        const startCardId = startCard?.getId?.() ?? null;
        const foundIndex = startCardId !== null ? this.#cards.findIndex((card) => card.getId() === startCardId) : -1;
        this.#startIndex = foundIndex >= 0 ? foundIndex : 0;
        this.#index = this.#startIndex;
        this._current = null;
    }

    #handleEvents()
    {
        const nextButton = this._studyPage.querySelector(".next-card-button");
        const previousButton = this._studyPage.querySelector(".previous-card-button");
        const showAnswerButton = this._studyPage.querySelector(".show-answer-button");
        const cardProgressionContainer = this._studyPage.querySelector(".card-progression-container");

        cardProgressionContainer.innerHTML = `${this.#startIndex + 1}/${this.#cards.length}`;

        nextButton.addEventListener("click", () =>
        {
            this.next();
            cardProgressionContainer.innerHTML = `${this.#index + 1}/${this.#cards.length}`;
        });

        previousButton.addEventListener("click", () =>
        {
            this.previous();
            cardProgressionContainer.innerHTML = `${this.#index + 1}/${this.#cards.length}`;
        });

        showAnswerButton.addEventListener("click", () =>
        {
            this._revealAnswer();
        });
    }

    start()
    {
        if(this.#cards.length === 0)
        {
            return;
        }

        this.#handleEvents();
        this._showCard(this.#cards[this.#index]);
    }

    next()
    {
        this.#index = (this.#index + 1) % this.#cards.length;
        this._showCard(this.#cards[this.#index]);
    }

    previous()
    {
        this.#index = (this.#index - 1 + this.#cards.length) % this.#cards.length;
        this._showCard(this.#cards[this.#index]);
    }

    /**
     * Preview lets the user skip freely, so Previous/Next stay visible from
     * the moment a card is shown — not just after the answer is revealed.
     */
    _showCard(card)
    {
        super._showCard(card);

        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");
        if (previousNextButtonContainer)
        {
            previousNextButtonContainer.style.display = "flex";
        }
    }

    _revealAnswer()
    {
        super._revealAnswer();

        // Preview never grades, so the score row stays hidden — only the
        // answer plus Previous/Next are surfaced after a reveal.
        const userScoreSection = this._studyPage.querySelector(".user-score-section");
        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");

        if (userScoreSection)
        {
            userScoreSection.style.display = "none";
        }
        if (previousNextButtonContainer)
        {
            previousNextButtonContainer.style.display = "flex";
        }
    }
}

export default CardPreviewSession;
