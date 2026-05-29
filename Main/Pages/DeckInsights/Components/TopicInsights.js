import DialogBox from "../../../CommonComponents/DialogBox.js";
import AiFeatureGate from "../../../Globals/Classes/AiFeatureGate.js";
import AnalysisTaskRunner from "../../../Globals/Classes/Analysis/AnalysisTaskRunner.js";
import Deck from "../../../Globals/Model/Deck.js";
import AutoAnalysisDeckFields from "../../../Globals/Classes/Analysis/AutoAnalysisDeckFields.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import { topicStrength } from "../../../Globals/Enumerations/TopicStrength.js";


/**
 * Renders the Strong / Weak / Confused topic panels for a deck by
 * reading the backend's `lastAnalysisTopics` block off
 * `deck.additionalData`. Doubles as the manual-trigger surface: the
 * "Run analysis now" button at the top wipes the existing analysis
 * block + curated materials for this deck and POSTs
 * /Analysis/QueueDeckAnalysis so the Agent re-runs immediately instead
 * of waiting for the next fresh login.
 *
 * Topic-tier styling reuses the existing classes in TopicInsights.css
 * (`.topic-section`, `.topic-header--weak/strong/volatile`,
 * `.topic-table`, `.topic-empty`).
 */
class TopicInsights extends HTMLElement
{
    static SECTION_DEFINITIONS = [
        { strengthValue: topicStrength.STRONG,   label: "Strong topics",   headerClass: "topic-header--strong",   emptyText: "No strong topics surfaced yet." },
        { strengthValue: topicStrength.WEAK,     label: "Weak topics",     headerClass: "topic-header--weak",     emptyText: "No weak topics surfaced yet." },
        { strengthValue: topicStrength.VOLATILE, label: "Confused topics", headerClass: "topic-header--volatile", emptyText: "No confused topics surfaced yet." }
    ];

    #deck = null;
    #bRunInFlight = false;

    connectedCallback()
    {
        this.#deck = Deck.getById(this.getAttribute("deck-id"));
        if (!this.#deck)
        {
            this.innerHTML = "";
            return;
        }

        this.#render();
        this.#bindRunButton();
    }

    #render()
    {
        const additionalData = this.#deck.getAdditionalData() || {};
        const analysisBlock  = additionalData[AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS];
        const bHasAnalysis   = analysisBlock && Array.isArray(analysisBlock.topics) && analysisBlock.topics.length > 0;

        const runButtonLabel = bHasAnalysis ? "Clear &amp; Re-analyse" : "Run analysis now";
        const headerHtml =
        `
            <div class="topic-insights-header">
                <h2 align="center">Topic Insights</h2>
                <div class="topic-insights-actions">
                    <button class="topic-insights-run-button">${runButtonLabel}</button>
                    <span class="topic-insights-status-message" hidden></span>
                </div>
            </div>
        `;

        if (!bHasAnalysis)
        {
            this.innerHTML =
            `
                ${headerHtml}
                <p class="topic-empty">Analysis hasn't run yet for this deck. Click <strong>Run analysis now</strong> to trigger it immediately, or enable performance analysis on the deck so the next fresh login does it automatically.</p>
            `;
            return;
        }

        const generatedAtIso = typeof analysisBlock.generatedAt === "string" ? analysisBlock.generatedAt : "";
        const generatedAtLine = generatedAtIso
            ? `<div class="topic-insights-status">Last analysed: ${TopicInsights.#formatGeneratedAt(generatedAtIso)}</div>`
            : "";

        const sectionsHtml = TopicInsights.SECTION_DEFINITIONS.map((sectionDefinition) =>
        {
            const tierTopics = TopicInsights.#filterTopicsForTier(analysisBlock.topics, sectionDefinition.strengthValue);
            return TopicInsights.#buildSectionHtml(sectionDefinition, tierTopics);
        }).join("");

        this.innerHTML =
        `
            ${headerHtml}
            ${generatedAtLine}
            ${sectionsHtml}
        `;
    }

    #bindRunButton()
    {
        const runButton = this.querySelector(".topic-insights-run-button");
        if (!runButton)
        {
            return;
        }

        runButton.addEventListener("click", async () =>
        {
            if (this.#bRunInFlight)
            {
                return;
            }

            if (!await AiFeatureGate.ensureAdminOrShowAlert())
            {
                return;
            }

            const additionalData = this.#deck.getAdditionalData() || {};
            const bHasAnalysis   = !!additionalData[AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS];
            const confirmTitle   = bHasAnalysis ? "Re-analyse this deck?" : "Run analysis now?";
            const confirmMessage = bHasAnalysis
                ? "This will delete the current topic results and all curated study materials generated for this deck, then queue a fresh analysis. The page will sync and refresh automatically once it's done. Continue?"
                : "Queue a fresh analysis for this deck now? The page will poll the task and auto-sync once the results land.";

            const confirmed = await DialogBox.confirm(confirmTitle, confirmMessage);
            if (!confirmed)
            {
                return;
            }

            this.#bRunInFlight = true;
            this.#setStatusMessage("Queuing analysis…");
            runButton.disabled = true;

            try
            {
                const runOutcome = await AnalysisTaskRunner.queueAndTrack(this.#deck,
                {
                    bClearPreviousFirst: bHasAnalysis,
                    bTriggerSync:        true,
                    onStatusChange:      (statusUpdate) => this.#applyStatusUpdate(statusUpdate),
                });

                if (runOutcome.status === taskStatus.COMPLETED)
                {
                    this.#setStatusMessage("Analysis complete — refreshing.");
                    this.#render();
                    this.#bindRunButton();
                }
                else
                {
                    this.#setStatusMessage("Analysis task ended in a failed state. Check the server logs.");
                    runButton.disabled = false;
                }
            }
            catch (runError)
            {
                console.warn("[TopicInsights] Analysis run failed:", runError);
                this.#setStatusMessage(`Analysis failed: ${runError.message || runError}`);
                runButton.disabled = false;
            }
            finally
            {
                this.#bRunInFlight = false;
            }
        });
    }

    /**
     * Translates AnalysisTaskRunner's status events into a user-facing
     * status line. The `progress` phase fires repeatedly while
     * polling, so the message reflects the task's running completion
     * percentage.
     */
    #applyStatusUpdate(statusUpdate)
    {
        if (!statusUpdate || typeof statusUpdate !== "object")
        {
            return;
        }

        switch (statusUpdate.phase)
        {
            case "queued":
                this.#setStatusMessage("Analysis queued on the server…");
                break;
            case "joined-existing-run":
                this.#setStatusMessage("An analysis is already running for this deck — tracking it now.");
                break;
            case "progress":
            {
                const completionFraction = (statusUpdate.taskTree && typeof statusUpdate.taskTree.completion === "number") ? statusUpdate.taskTree.completion : 0;
                const completionPercent = Math.max(0, Math.min(100, Math.round(completionFraction * 100)));
                this.#setStatusMessage(`Analysis running — ${completionPercent}%`);
                break;
            }
            case "task-terminal":
                if (statusUpdate.status === taskStatus.COMPLETED)
                {
                    this.#setStatusMessage("Analysis done — syncing results…");
                }
                break;
            case "sync-complete":
                this.#setStatusMessage("Sync complete — loading updated topics.");
                break;
            default:
                break;
        }
    }

    #setStatusMessage(messageText)
    {
        const statusElement = this.querySelector(".topic-insights-status-message");
        if (!statusElement)
        {
            return;
        }
        statusElement.textContent = messageText;
        statusElement.hidden = !messageText;
    }

    static #filterTopicsForTier(topics, strengthValue)
    {
        const expectedName = TopicInsights.#strengthEnumName(strengthValue);
        return topics.filter((topicEntry) =>
        {
            return topicEntry && typeof topicEntry === "object" && topicEntry.strength === expectedName;
        });
    }

    static #buildSectionHtml(sectionDefinition, tierTopics)
    {
        if (tierTopics.length === 0)
        {
            return `
                <div class="topic-section">
                    <h3 class="topic-section-title ${sectionDefinition.headerClass}">${TopicInsights.#escapeHtml(sectionDefinition.label)}</h3>
                    <p class="topic-empty">${TopicInsights.#escapeHtml(sectionDefinition.emptyText)}</p>
                </div>
            `;
        }

        const rowsHtml = tierTopics.map((topicEntry) =>
        {
            const topicName = TopicInsights.#escapeHtml(topicEntry.name || "");
            const reasonText = TopicInsights.#escapeHtml(topicEntry.reason || "");
            return `
                <tr>
                    <td>${topicName}</td>
                    <td>${reasonText}</td>
                </tr>
            `;
        }).join("");

        return `
            <div class="topic-section">
                <h3 class="topic-section-title ${sectionDefinition.headerClass}">${TopicInsights.#escapeHtml(sectionDefinition.label)}</h3>
                <table class="topic-table">
                    <thead>
                        <tr>
                            <th>Topic</th>
                            <th>Why</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        `;
    }

    /**
     * Maps a numeric topicStrength enum value back to its canonical name
     * (e.g. 0 → "WEAK"). The backend persists the name string, not the
     * integer, so the filter compares names.
     */
    static #strengthEnumName(strengthValue)
    {
        for (const enumKey of Object.keys(topicStrength))
        {
            if (topicStrength[enumKey] === strengthValue)
            {
                return enumKey;
            }
        }
        return "";
    }

    static #formatGeneratedAt(isoTimestamp)
    {
        const parsedDate = new Date(isoTimestamp);
        if (Number.isNaN(parsedDate.getTime()))
        {
            return TopicInsights.#escapeHtml(isoTimestamp);
        }
        return parsedDate.toLocaleString();
    }

    static #escapeHtml(rawText)
    {
        if (typeof rawText !== "string")
        {
            return "";
        }
        return rawText
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
}

customElements.define("topic-insights", TopicInsights);
export default TopicInsights;
