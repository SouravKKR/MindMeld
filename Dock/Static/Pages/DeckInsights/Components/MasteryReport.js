import DialogBox from "../../../CommonComponents/DialogBox.js";
import Deck from "../../../Globals/Model/Deck.js";
import Chart from "../../../ThirdParty/Chart/chart.js";
import { computeMastery } from "../UtilityFunctions/ComputeMastery.js";

class MasteryReport extends HTMLElement
{
    #deck = null;
    #masteryProgressionChart = null;

    #constructMasteryProgressionChart()
    {
        const chartCanvas = this.querySelector(".mastery-progression-chart");
        const startDate = new Date(this.querySelector(".start-date-input").value);
        const endDate = new Date(this.querySelector(".end-date-input").value);

        chartCanvas.innerHTML = "";
        this.#masteryProgressionChart?.destroy();
        
        if(!startDate || !endDate)
        {
            DialogBox.alert("Error!", "Please select a valid start and end date.");
        }

        if(startDate > endDate)
        {
            DialogBox.alert("Error!", "End date cannot be before start date.");
        }

        const labels = [];
        const data = [];

        const current = new Date(startDate);

        while (current <= endDate)
        {
            const mastery = computeMastery(this.#deck, new Date(current));

            labels.push(current.toISOString().split("T")[0]);
            data.push(Math.round(mastery * 100));

            current.setDate(current.getDate() + 1);
        }

        this.#masteryProgressionChart = new Chart(chartCanvas,
        {
            type: "line",
            data:
            {
                labels: labels,
                datasets:
                [
                    {
                        label: "Mastery %",
                        data: data,
                        tension: 0.4,
                        fill: false
                    }
                ]
            },
            options:
            {
                responsive: true,
                maintainAspectRatio: false,
                scales:
                {
                    y:
                    {
                        min: 0,
                        max: 100
                    }
                }
            }
        });
        

    }

    #handleEvents()
    {
        const dateInputs = this.querySelectorAll(".date-range-container input");
        dateInputs.forEach(input => input.addEventListener("change", () => this.#constructMasteryProgressionChart()));
    }

    connectedCallback()
    {
        this.#deck = Deck.getById(this.getAttribute("deck-id"));

        // The deck may not be in the id map (e.g. a transient paid-study deck
        // after a reload / identity change) — guard like StudyActivityHeatmap.
        if (!this.#deck)
        {
            this.innerHTML = "";
            return;
        }

        const masteryScore = computeMastery(this.#deck, new Date());
        const today = new Date();
        const oneWeekAgo = new Date(today);
        oneWeekAgo.setDate(today.getDate() - 7);
        const startDate = oneWeekAgo.toISOString().split("T")[0];
        const endDate = today.toISOString().split("T")[0];

        this.innerHTML = 
        `
            <h3>Overall Mastery:  <span style="font-weight: normal">${Math.round(masteryScore * 100)}%</span></h3> 
            <h3>Mastery Progression Over Time</h3>
            <div class="date-range-container">
                Start Date:
                <input type="date" class="start-date-input" value="${startDate}">
                End Date:
                <input type="date" class="end-date-input" value="${endDate}">
            </div>
            <div class="mastery-progression-chart-container">
                <canvas class="mastery-progression-chart"></canvas>
            <div>
        `;

        
        this.#constructMasteryProgressionChart();
        this.#handleEvents();

    }
}

customElements.define("mastery-report", MasteryReport);
export default MasteryReport;