import Card from "../../../Globals/Model/Card.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import ActiveEntityTracker from "../../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";

class StudySession
{
    /**
     * Constructs a StudySession object.
     * @param {StudyPage} studyPage - The associated StudyPage object.
     */
    constructor(studyPage, deck = null)
    {
        this._studyPage = studyPage;
        this._deck = deck;
        this._current = null;
    }

    start()
    {
        throw new Error("Cannot call method on abstract class!");
    }

    next()
    {
        throw new Error("Cannot call method on abstract class!");
    }

    _showCard(card)
    {
        if(!(card instanceof Card))
        {
            return;
        }

        const questionSection = this._studyPage.querySelector(".question-section");
        const answerSection = this._studyPage.querySelector(".answer-section");
        const showAnswerButton = this._studyPage.querySelector(".show-answer-button");
        const userScoreSection = this._studyPage.querySelector(".user-score-section");
        const previousNextButtonContainer = this._studyPage.querySelector(".previous-next-button-container");

        this._current = card;

        ActiveEntityTracker.set(card.getId(), entityTypes.CARD);

        const editCardButton = this._studyPage.querySelector(".edit-card-button");

        if (editCardButton)
        {
            editCardButton.onclick = () =>
            {
                PageNavigator.open("card-editor-page", card, card.getDeck());
            };
        }

        questionSection.innerHTML = HtmlSanitizer.sanitize(card.getQuestion());
        answerSection.innerHTML = "";

        showAnswerButton.style.display = "block";
        userScoreSection.style.display = "none";
        previousNextButtonContainer.style.display = "none";

        // Notify the bottom panel (and any other listener) that the
        // visible card just changed, so per-entity controls like the
        // Mark-for-Review toggle can refresh their state.
        window.dispatchEvent(new CustomEvent(StudySessionEvents.CARD_CHANGED, {detail: {card: card}}));
    }

    onResumed()
    {
        if (this._current instanceof Card)
        {
            this._showCard(this._current);
        }
    }

    _revealAnswer()
    {
        const answerSection = this._studyPage.querySelector(".answer-section");
        const showAnswerButton = this._studyPage.querySelector(".show-answer-button");
        
        if(!(this._current instanceof Card))
        {
            return;
        }

        answerSection.innerHTML = HtmlSanitizer.sanitize(this._current.getAnswer());
        showAnswerButton.style.display = "none";

    }

}

export default StudySession;