import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";
import CuratedFlashcardFields from "../../../Globals/Classes/Analysis/CuratedFlashcardFields.js";

class ReviseSession extends StudySession
{
    #cards = [];
    #index = -1;

    constructor(studyPage, deck = null)
    {
        super(studyPage, deck);
        // getCards() already excludes curated cards by default, but the
        // explicit second filter here is defence in depth — anyone
        // sneaking a curated card into the deck's review-flagged set
        // shouldn't be able to short-circuit FSRS by routing through
        // Revise.
        this.#cards = deck.getCards(true).filter((card) => card.isReview() && card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] !== true);
        this.#index = -1;
        this._current = null;

        if(this.#cards.length == 0)
        {
            PageNavigator.back();
            DialogBox.alert("Note", "No cards are there to revise.<br><br>Please mark the cards for review.");
        }
    }

    #handleEvents()
    {
        const nextButton = this._studyPage.querySelector(".next-card-button");
        const previousButton = this._studyPage.querySelector(".previous-card-button");
        const showAnswerButton = this._studyPage.querySelector(".show-answer-button");
        const cardProgessionContainer = this._studyPage.querySelector(".card-progression-container");

        cardProgessionContainer.innerHTML = `${1}/${this.#cards.length}`;

        nextButton.addEventListener("click", () =>
        { 
            this.next();
            cardProgessionContainer.innerHTML = `${this.#index + 1}/${this.#cards.length}`;
        });

        previousButton.addEventListener("click", () =>
        { 
            this.previous()
            cardProgessionContainer.innerHTML = `${this.#index + 1}/${this.#cards.length}`;
        });

        showAnswerButton.addEventListener("click", () =>
        { 
            this._revealAnswer();
        });
    }

    start()
    {
        this.#handleEvents();
        this.next();
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
     * Revise lets the user skip freely, so prev/next stay visible from the
     * moment a card is shown — not just after the answer is revealed. The
     * Spaced-Repetition session deliberately keeps the base behavior (prev/
     * next hidden until a grade is submitted) so the algorithm-driven order
     * can't be bypassed.
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

        const userScoreSection = this._studyPage.querySelector(".user-score-section");
        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");

        userScoreSection.style.display = "none";
        previousNextButtonContainer.style.display = "flex";
    }


}

export default ReviseSession