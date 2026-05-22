import Deck from "../../../Globals/Model/Deck.js";
import Chart from "../../../ThirdParty/Chart/chart.js";
import MasteryReport from "./MasteryReport.js";

class DeckInsights extends HTMLElement
{
    #deck = null;

    connectedCallback()
    {
        this.#deck = Deck.getById(this.getAttribute("deck-id"))
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

            <div class="mastery-report-container">
                <h2 align="center">Mastery Report</h2>
                <mastery-report deck-id="${this.#deck.getId()}"></mastery-report>
            </div>

        `;
    }
}

customElements.define("deck-insights", DeckInsights);
export default DeckInsights;