import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import PriorityQueue from "../../../Globals/Classes/PriorityQueue.js";
import StudySession from "./StudySession.js";

class SpacedRepetitonSession extends StudySession
{
    #priorityQueue = null;
    #startTime = null;

    /**
     * Constructor for SpacedRepetitionSession class.
     * @param {Deck} deck - The deck associated with the session.
     */
    constructor(studyPage, deck = null)
    {
        super(studyPage, deck);

        const comparator = (a, b) =>
        {
            return a.getDueDate() - b.getDueDate(); 
        };

        this.#priorityQueue = new PriorityQueue(this._deck.getCards(true), comparator);
        this.#startTime = new Date();
    }
    
    getStartTime()
    {
        return this.#startTime;
    }
    
    start()
    {
        this.#handleEvents();
        this.next();
    }

    next()
    {
        if(this.#priorityQueue.isEmpty())
        {
            //TODO: Move this to study page (make a method and call that instead of importing DialogBox here) 
            DialogBox.alert("Note", "No cards are there to study.<br>Please add some cards.");
            return null;
        }
        
        const card = this.#priorityQueue.peek();
        const twoMinutes = 120 * 1000;

        if(card.getDueDate() > (Date.now() + twoMinutes))
        {
            //TODO: Create a method in study page to give a congratulation message
            DialogBox.alert("Note", "You have studied all the cards in this deck for now.<br><br>Please come back at: " + new Date(card.getDueDate()).toLocaleString());
            PageNavigator.back();
            return null;
        }

        const cardToShow = card;

        this._showCard(cardToShow);

        return this.#priorityQueue.pop();
    }

    
    attempt(userRating)
    {
        this._current.attempt(userRating, this.getTimeSpent(), true).then(() =>
        {
            this.#priorityQueue.push(this._current);
            this.next();
        });
    }

    getTimeSpent()
    {
        return Date.now() - this.#startTime;
    }

    #handleEvents()
    {
        
        const showAnswerButton = this._studyPage.querySelector(".show-answer-button");
        const userScoreSection = this._studyPage.querySelector(".user-score-section");

        const scoreButtons = userScoreSection.querySelectorAll("button");

        for(const button of scoreButtons)
        {
            button.addEventListener("click", () => 
            {
                const score = parseFloat(button.getAttribute("score"));
                this.attempt(score);
            });
        }

        showAnswerButton.addEventListener("click", () =>
        { 
            this._revealAnswer();
        });
    }

    _revealAnswer()
    {
        super._revealAnswer();

        const userScoreSection = this._studyPage.querySelector(".user-score-section");
        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");
        
        userScoreSection.style.display = "flex";
        previousNextButtonContainer.style.display = "none";

    }

}

export default SpacedRepetitonSession;