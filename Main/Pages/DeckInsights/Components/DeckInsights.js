import Deck from "../../../Globals/Model/Deck.js";
import Chart from "../../../ThirdParty/Chart/chart.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import MasteryReport from "./MasteryReport.js";
import TopicInsights from "./TopicInsights.js";
import StudyActivityHeatmap from "./StudyActivityHeatmap.js";

class DeckInsights extends HTMLElement
{
    #deck = null;

    connectedCallback()
    {
        this.#deck = Deck.getById(this.getAttribute("deck-id"))

        // The deck may not be in the id map (e.g. a transient paid-study deck
        // after a reload / identity change) — guard like the sibling widgets.
        if (!this.#deck)
        {
            this.innerHTML = "";
            return;
        }

        const deckId = this.#deck.getId();
        const bAiAllowed = AiFeatureGate.isAllowed();

        const adminOnlyBlock = bAiAllowed
            ? `
                <study-activity-heatmap deck-id="${deckId}"></study-activity-heatmap>

                <div style="margin: 30px"></div>

                <topic-insights deck-id="${deckId}"></topic-insights>

                <div style="margin: 30px"></div>
            `
            : "";

        this.innerHTML =
        `
            <div class="study-insights-container">
                <h2 align="center">Study Insights</h2>
                <table class="study-insights-table">
                    <tr>
                        <td>Total Cards: </td>
                        <td>${this.#deck.getCardCount()}</td>
                    </tr>
                    <tr>
                        <td>Due Cards: </td>
                        <td>${this.#deck.getDueCardCount()}</td>
                    </tr>
                    <tr>
                        <td>Review Cards: </td>
                        <td>${this.#deck.getCards().filter(card => card.isReview()).length}</td>
                    </tr>
                </table>
            </div>

            <div style="margin: 30px"></div>

            ${adminOnlyBlock}

            <div class="mastery-report-container">
                <h2 align="center">Mastery Report</h2>
                <mastery-report deck-id="${deckId}"></mastery-report>
            </div>

        `;
    }
}

customElements.define("deck-insights", DeckInsights);
export default DeckInsights;
