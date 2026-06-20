import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import PriorityQueue from "../../../Globals/Classes/PriorityQueue.js";
import StudySession from "./StudySession.js";
import CuratedFlashcardFields from "../../../Globals/Classes/Analysis/CuratedFlashcardFields.js";

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

        // Funnel both sides through `new Date(...).getTime()` so a
        // mixed-type heap (some cards' Fsrs.due round-tripped as Date,
        // others as ISO string) still compares as a pair of timestamp
        // numbers. Without this, a single string-typed card amongst the
        // Date-typed siblings produces NaN comparator results — the
        // heap leaves whichever card happened to land at the root sat
        // there, even when past-due cards exist further down.
        // `this._deck.getCards(true)` recurses into sub-decks, so a
        // session opened on a parent deck pulls in every sub-deck card.
        const comparator = (firstCard, secondCard) =>
        {
            return new Date(firstCard.getDueDate()).getTime() - new Date(secondCard.getDueDate()).getTime();
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

        // Defence in depth: getCards() already excludes curated cards by
        // default, so the priority queue should never contain one. If
        // anyone constructs the session against a queue that did leak a
        // curated card through, skip it loudly rather than burn an FSRS
        // attempt on it.
        if (card.getAdditionalData()?.[CuratedFlashcardFields.B_CURATED] === true)
        {
            console.error("SpacedRepetitionSession received a curated card (" + card.getId() + ") — skipping. This indicates a getCards() call somewhere passed bIncludeCurated=true into a non-curated session.");
            this.#priorityQueue.pop();
            return this.next();
        }

        // Use the same isDue() predicate that getDueCardCount filters
        // on. Previously this site used `card.getDueDate() > now+2min`
        // inline, which silently produced `false` (i.e. "go study this
        // card") when due was an ISO string instead of a Date — but
        // ALSO silently produced `true` ("studied all") when an earlier
        // mixed-type comparator left a future-dated card at the root.
        // Going through isDue() keeps the count and the queue agreeing
        // about which cards are due.
        if (!card.isDue())
        {
            //TODO: Create a method in study page to give a congratulation message
            const nextDueDate = new Date(card.getDueDate());
            DialogBox.alert("Note", "You have studied all the cards in this deck for now.<br><br>Please come back at: " + nextDueDate.toLocaleString());
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
            // Cards studied is recomputed server-side from fsrs.repetitions on the
            // next /Metrics/Sync (study-page leave / login) — no per-card report.
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