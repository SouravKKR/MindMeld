import Card from "../../../Globals/Model/Card.js";
import HtmlSanitizer from "../../../Globals/Classes/HtmlSanitizer.js";
import PaidDeckCopyGuard from "../../../Globals/Classes/Security/PaidDeckCopyGuard.js";
import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import ActiveEntityTracker from "../../../Globals/Classes/ActiveEntityTracker.js";
import { entityTypes } from "../../../Globals/Enumerations/EntityTypes.js";
import StudySessionEvents from "../Events/StudySessionEvents.js";
import MetricTracker from "../../../Globals/Classes/Metrics/MetricTracker.js";
import ActivityMonitor from "../../../Globals/Classes/Activity/ActivityMonitor.js";

class StudySession
{
    // Activity-gated study-time ticker: banks time toward the "hours studied"
    // metric only while the user is actually active (and the page is visible),
    // so an idle (>5 min) or backgrounded app accrues nothing. Lives in the base
    // so every session subtype (spaced rep, content, revise, mock, curated)
    // contributes time uniformly.
    static #STUDY_TICK_SECONDS = 30;
    #studyTickIntervalId = null;

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

    /** Start banking active study time (call on study start / resume / tab visible). */
    startStudyTimer()
    {
        if (this.#studyTickIntervalId !== null || typeof window === "undefined")
        {
            return;
        }
        this.#studyTickIntervalId = window.setInterval(() =>
        {
            if (ActivityMonitor.isActive())
            {
                MetricTracker.addStudySeconds(StudySession.#STUDY_TICK_SECONDS);
            }
        }, StudySession.#STUDY_TICK_SECONDS * 1000);
    }

    /** Stop banking study time (call on page leave / tab hidden). */
    stopStudyTimer()
    {
        if (this.#studyTickIntervalId !== null)
        {
            window.clearInterval(this.#studyTickIntervalId);
            this.#studyTickIntervalId = null;
        }
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

        StudySession.#protectPaidContent(card, questionSection, answerSection);

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
        StudySession.#protectPaidContent(this._current, null, answerSection);
        showAnswerButton.style.display = "none";

    }

    /**
     * Registers a paid card's rendered sections with the copy guard, so
     * copy / cut / right-click are blocked over the seller's content while
     * selection (and therefore Ask-AI-on-selection) keeps working. A no-op on a
     * normal deck.
     */
    static #protectPaidContent(card, questionSection, answerSection)
    {
        const paidDeckId = card?.getDeck?.()?.getAdditionalData?.()?.paidDeckId;
        if (!paidDeckId)
        {
            return;
        }

        for (const renderedSection of [questionSection, answerSection])
        {
            if (renderedSection)
            {
                PaidDeckCopyGuard.registerContainer(renderedSection, paidDeckId, card.getId());
            }
        }
    }
}

export default StudySession;