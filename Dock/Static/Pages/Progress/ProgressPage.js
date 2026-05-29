import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import GenerationProgressComponent from "./Components/GenerationProgressComponent.js";
import { taskStatus } from "../../Globals/Enumerations/TaskStatus.js";
import { taskTypes } from "../../Globals/Enumerations/TaskTypes.js";
import { enumerationToTitleCase } from "../../Globals/UtilityFunctions/EnumerationToTitleCase.js";

const POLL_INTERVAL_MILLIS = 2000;
const DEFAULT_PROGRESS_ENDPOINT = "/Generate/Progress";
const DEFAULT_PAGE_TITLE = "Generation in Progress";

/**
 * ProgressPage
 *
 * Renders live or historical progress for a single task. Used by:
 *   1. AutomaticGenerationPage — opens with the default options after
 *      a generate-pipeline kicks off.
 *   2. ActivityPage — opens with the Activity endpoint so completed
 *      tasks fall back to the taskHistory record (historical: true) and
 *      render a metadata summary instead of a live tree.
 *
 * initialize(taskId, options)
 *   options.endpointUrl — progress endpoint to poll (defaults to
 *                         /Generate/Progress to preserve the original
 *                         generation flow). Pass /Activity/Tasks/Progress
 *                         to enable history fallback + ownership check.
 *   options.title       — header title override (defaults to
 *                         "Generation in Progress").
 */
class ProgressPage extends HTMLElement
{
    #taskId = null;
    #endpointUrl = DEFAULT_PROGRESS_ENDPOINT;
    #pageTitle = DEFAULT_PAGE_TITLE;
    #continueBehavior = "home";
    #pollIntervalId = null;
    #bTerminated = false;

    initialize(taskId, options = {})
    {
        this.#taskId = taskId;
        if (options && typeof options.endpointUrl === "string" && options.endpointUrl.length > 0)
        {
            this.#endpointUrl = options.endpointUrl;
        }
        if (options && typeof options.title === "string" && options.title.length > 0)
        {
            this.#pageTitle = options.title;
        }
        if (options && (options.continueBehavior === "home" || options.continueBehavior === "back"))
        {
            this.#continueBehavior = options.continueBehavior;
        }
    }

    #getProgressComponent()
    {
        return this.querySelector("generation-progress-component");
    }

    async #poll()
    {
        if (this.#bTerminated) return;

        try
        {
            const response = await fetch(`${this.#endpointUrl}?taskid=${encodeURIComponent(this.#taskId)}`);

            if (!response.ok)
            {
                console.warn(`[ProgressPage] Poll returned ${response.status}`);
                if (response.status === 404 || response.status === 403)
                {
                    this.#stopPolling();
                    this.#renderUnavailable(response.status);
                }
                return;
            }

            const payload = await response.json();

            // Historical record (Activity flow): live descriptor expired,
            // server returned the archived row. Render the metadata view
            // and stop polling — nothing is going to change.
            if (payload && payload.historical === true)
            {
                this.#stopPolling();
                this.#renderHistorical(payload);
                return;
            }

            this.#getProgressComponent().update(payload);

            if (this.#getProgressComponent().isTerminal())
            {
                this.#stopPolling();
                this.#onTerminated(payload.status);
            }
        }
        catch (error)
        {
            console.error("[ProgressPage] Poll error:", error);
        }
    }

    #startPolling()
    {
        this.#poll();
        this.#pollIntervalId = setInterval(() => this.#poll(), POLL_INTERVAL_MILLIS);
    }

    #stopPolling()
    {
        if (this.#pollIntervalId !== null)
        {
            clearInterval(this.#pollIntervalId);
            this.#pollIntervalId = null;
        }
    }

    #onTerminated(status)
    {
        this.#bTerminated = true;

        const bSuccess = status === taskStatus.COMPLETED;

        const statusBanner = this.querySelector(".progress-page-status-banner");

        if (bSuccess)
        {
            statusBanner.textContent = "Generation complete — your decks are ready.";
            statusBanner.classList.add("progress-page-status-banner--success");
        }
        else
        {
            statusBanner.textContent = "Generation failed. Please try again.";
            statusBanner.classList.add("progress-page-status-banner--error");
        }

        statusBanner.style.display = "block";
    }

    #renderHistorical(payload)
    {
        this.#bTerminated = true;

        const headerComponent = this.querySelector("header-component");
        if (headerComponent && typeof headerComponent.setAttribute === "function")
        {
            headerComponent.setAttribute("title", "Task completed");
        }

        const progressComponent = this.#getProgressComponent();
        if (progressComponent)
        {
            progressComponent.style.display = "none";
        }

        const statusBanner = this.querySelector(".progress-page-status-banner");
        if (payload.status === taskStatus.FAILED)
        {
            statusBanner.textContent = "This task ended with a failure.";
            statusBanner.classList.add("progress-page-status-banner--error");
        }
        else
        {
            statusBanner.textContent = "This task has been completed.";
            statusBanner.classList.add("progress-page-status-banner--success");
        }
        statusBanner.style.display = "block";

        const leftColumn = this.querySelector(".progress-page-left");
        if (leftColumn && !leftColumn.querySelector(".progress-page-historical"))
        {
            leftColumn.insertAdjacentHTML("beforeend", ProgressPage.#buildHistoricalCardHtml(payload));
        }

        const continueButton = this.querySelector(".progress-page-continue-button");
        if (continueButton)
        {
            continueButton.textContent = "Back to Activity →";
        }
    }

    #renderUnavailable(statusCode)
    {
        this.#bTerminated = true;

        const progressComponent = this.#getProgressComponent();
        if (progressComponent)
        {
            progressComponent.style.display = "none";
        }

        const statusBanner = this.querySelector(".progress-page-status-banner");
        statusBanner.textContent = statusCode === 403
            ? "You do not have access to this task."
            : "This task is no longer available.";
        statusBanner.classList.add("progress-page-status-banner--error");
        statusBanner.style.display = "block";
    }

    static #buildHistoricalCardHtml(payload)
    {
        const rows = [];
        rows.push({ label: "Type", value: ProgressPage.#humaniseType(payload.type) });

        if (payload.payloadSummary && payload.payloadSummary !== ProgressPage.#humaniseType(payload.type))
        {
            rows.push({ label: "Summary", value: payload.payloadSummary });
        }
        const completedAt = ProgressPage.#formatDateTime(payload.completedAt);
        if (completedAt)
        {
            rows.push({ label: "Completed", value: completedAt });
        }
        const startedAt = ProgressPage.#formatDateTime(payload.startDate);
        if (startedAt)
        {
            rows.push({ label: "Started", value: startedAt });
        }
        const duration = ProgressPage.#formatDuration(payload.durationMillis);
        if (duration)
        {
            rows.push({ label: "Duration", value: duration });
        }
        if (payload.parentTaskId)
        {
            rows.push({ label: "Parent task", value: payload.parentTaskId });
        }

        const completionPercent = Math.round(Math.max(0, Math.min(1, payload.completion || 0)) * 100);
        rows.push({ label: "Completion", value: `${completionPercent}%` });

        const additionalData = (payload.additionalData && typeof payload.additionalData === "object") ? payload.additionalData : {};
        for (const key of Object.keys(additionalData))
        {
            const rawValue = additionalData[key];
            if (rawValue === null || rawValue === undefined) continue;
            const displayValue = typeof rawValue === "object" ? JSON.stringify(rawValue) : String(rawValue);
            rows.push({ label: ProgressPage.#humaniseKey(key), value: displayValue });
        }

        const rowsHtml = rows
            .map((row) => `
                <div class="progress-page-historical-row">
                    <span class="progress-page-historical-key">${ProgressPage.#escape(row.label)}</span>
                    <span class="progress-page-historical-value">${ProgressPage.#escape(row.value)}</span>
                </div>
            `)
            .join("");

        return `
            <div class="progress-page-historical">
                <div class="progress-page-historical-title">Task details</div>
                <div class="progress-page-historical-rows">${rowsHtml}</div>
            </div>
        `;
    }

    static #humaniseType(typeValue)
    {
        const typeName = Object.keys(taskTypes).find((key) => taskTypes[key] === typeValue);
        return typeName ? enumerationToTitleCase(typeName) : "Task";
    }

    static #humaniseKey(rawKey)
    {
        const spaced = String(rawKey).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
        return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }

    static #formatDateTime(rawValue)
    {
        if (!rawValue) return "";
        const date = new Date(rawValue);
        if (Number.isNaN(date.getTime())) return "";
        return date.toLocaleString();
    }

    static #formatDuration(rawMillis)
    {
        const millis = Number(rawMillis);
        if (!Number.isFinite(millis) || millis <= 0) return "";
        const totalSeconds = Math.floor(millis / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
        return parts.join(" ");
    }

    static #escape(rawString)
    {
        if (rawString === null || rawString === undefined) return "";
        return String(rawString)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    #handleEvents()
    {
        const continueButton = this.querySelector(".progress-page-continue-button");

        continueButton.addEventListener("click", () =>
        {
            this.#stopPolling();
            if (this.#continueBehavior === "back")
            {
                PageNavigator.back();
            }
            else
            {
                PageNavigator.clearAndOpen("home-page");
            }
        });
    }

    connectedCallback()
    {
        this.setAttribute("page", "");

        this.innerHTML =
        `
            <header-component title="${ProgressPage.#escape(this.#pageTitle)}"></header-component>

            <div class="progress-page-body">

                <div class="progress-page-left">
                    <div class="progress-page-section-title">Generation Pipeline</div>
                    <div class="progress-page-status-banner"></div>
                    <generation-progress-component></generation-progress-component>
                </div>

                <div class="progress-page-right">
                    <div class="progress-page-section-title">Sponsored</div>
                    <div class="progress-page-ad-slot">
                        <img class="progress-page-ad-placeholder-icon" src="./Globals/Assets/Images/Icons/AdPlaceholderIcon.svg" alt="">
                        <span class="progress-page-ad-label">Advertisement</span>
                    </div>
                </div>

            </div>

            <div class="progress-page-footer">
                <button class="progress-page-continue-button">Continue Studying →</button>
            </div>
        `;

        this.#handleEvents();

        if (this.#taskId)
        {
            this.#startPolling();
        }
    }

    disconnectedCallback()
    {
        this.#stopPolling();
    }
}

customElements.define("progress-page", ProgressPage);
export default ProgressPage;
