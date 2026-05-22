import DialogBox from "../../../CommonComponents/DialogBox.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import StudySession from "./StudySession.js";

class ReviseSession extends StudySession
{
    #cards = [];
    #index = -1;

    constructor(studyPage, deck = null)
    {
        super(studyPage, deck);
        this.#cards = deck.getCards(true).filter((card) => { return card.isReview() });
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