import PageNavigator from "../../Globals/Classes/PageNavigator.js";
import GenerationProgressComponent from "./Components/GenerationProgressComponent.js";
import { taskStatus } from "../../Globals/Enumerations/TaskStatus.js";
import { taskTypes } from "../../Globals/Enumerations/TaskTypes.js";
import { taskTypeDisplayName } from "../../Globals/UtilityFunctions/TaskTypeDisplayName.js";
import OutOfCreditsResumeFlow from "../../Globals/Classes/Credits/OutOfCreditsResumeFlow.js";
import PartialGenerationRetryFlow from "../../Globals/Classes/Task/PartialGenerationRetryFlow.js";
import { formatCredits } from "../../Globals/UtilityFunctions/FormatCredits.js";
import GenerationNotifier from "../../Globals/Classes/Notifications/GenerationNotifier.js";
import TutorialEngine from "../../Globals/Classes/TutorialEngine.js";
import TutorialDemoResponses from "../../Globals/Constants/TutorialDemoResponses.js";
import TutorialSampleDeckBuilder from "../../Globals/Classes/Tutorials/TutorialSampleDeckBuilder.js";

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
    #demoTimeoutId = null;

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
            this.#updateLiveStatus(payload);

            // The !bTerminated guard prevents a second, overlapping poll from
            // re-firing onTerminated (and a duplicate out-of-credits popup) in
            // the window before the interval is cleared.
            if (!this.#bTerminated && this.#getProgressComponent().isTerminal())
            {
                this.#stopPolling();
                this.#onTerminated(payload);
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

    /**
     * Tutorial demo: instead of polling /Generate/Progress, drive the
     * progress component through a canned sequence of task-tree snapshots
     * that climb to completion, then show the success banner and drop a
     * flagged local "generated" deck onto the home page. No fetch, no
     * credits, no real task.
     */
    #playTutorialDemo()
    {
        const progressComponent = this.#getProgressComponent();
        const snapshots = TutorialDemoResponses.getGenerationProgressSnapshots();
        let snapshotIndex = 0;

        const advance = () =>
        {
            if (!this.isConnected || this.#bTerminated)
            {
                return;
            }

            const snapshot = snapshots[snapshotIndex];
            progressComponent.update(snapshot);
            snapshotIndex += 1;

            if (snapshotIndex < snapshots.length)
            {
                this.#demoTimeoutId = setTimeout(advance, TutorialDemoResponses.GENERATION_STEP_DELAY_MILLISECONDS);
                return;
            }

            this.#onTerminated(snapshot);
            TutorialSampleDeckBuilder.createGeneratedSampleForUser().catch((buildError) =>
                console.warn("[ProgressPage] Tutorial generated-deck build failed:", buildError));
        };

        advance();
    }

    #stopPolling()
    {
        if (this.#pollIntervalId !== null)
        {
            clearInterval(this.#pollIntervalId);
            this.#pollIntervalId = null;
        }
    }

    #onTerminated(payload)
    {
        this.#bTerminated = true;

        // The live-only notices (provider-busy banner, TTL note) and the pause
        // control are meaningless once the run is terminal — hide them so the
        // terminal status banner stands alone.
        const liveBanner = this.querySelector(".progress-page-live-banner");
        if (liveBanner) liveBanner.style.display = "none";
        const ttlNote = this.querySelector(".progress-page-ttl-note");
        if (ttlNote) ttlNote.style.display = "none";
        const pauseButton = this.querySelector(".progress-page-pause-button");
        if (pauseButton) pauseButton.style.display = "none";

        // For an AI generation, append the per-task credit-spend breakdown so
        // the user can see where their credits went (regardless of outcome).
        if (payload && payload.type === taskTypes.PREPARE_FOR_GENERATION)
        {
            this.#renderCreditSummary(this.#taskId).catch(summaryError => console.error("[ProgressPage] credit summary error:", summaryError));
        }

        const statusBanner = this.querySelector(".progress-page-status-banner");

        // Out-of-credits stop is checked first via the server-computed flag,
        // not payload.status — the root task can read COMPLETED even when a
        // deep child failed on credits. It's recoverable: show the top-up /
        // resume flow instead of a dead-end "failed" message.
        if (payload && payload.outOfCredits === true)
        {
            statusBanner.textContent = "Generation paused — you ran out of credits. Top up to continue.";
            statusBanner.classList.add("progress-page-status-banner--error");
            statusBanner.style.display = "block";
            OutOfCreditsResumeFlow.present().catch(presentError => console.error("[ProgressPage] out-of-credits flow error:", presentError));
            return;
        }

        // Partial completion: one output type failed but the others were kept.
        // Offer "keep them and retry the rest" instead of a dead-end "Failed".
        if (payload && payload.partialCompletion)
        {
            this.#renderPartialCompletion(payload.partialCompletion);
            return;
        }

        // User-initiated pause: recoverable, not a failure. Point the user at
        // the home-screen resume banner; the saved state lives for 7 days.
        if (payload && payload.paused === true)
        {
            statusBanner.textContent = "Generation paused. Resume it within 7 days from the banner on your home screen — it picks up from where it left off.";
            statusBanner.classList.add("progress-page-status-banner--warning");
            statusBanner.style.display = "block";
            return;
        }

        // Post-pipeline image step failed (text succeeded, images did not).
        // Recoverable: the run is held un-persisted with a resumable snapshot, so
        // point the user at the home-screen resume banner instead of a dead-end
        // "failed". Resuming re-runs only the image step and then persists text +
        // images together.
        if (payload && payload.imagePreparationFailed === true)
        {
            statusBanner.textContent = "Your text is ready, but image preparation didn't finish. Resume within 7 days from the banner on your home screen to finish adding images — it picks up from where it left off.";
            statusBanner.classList.add("progress-page-status-banner--warning");
            statusBanner.style.display = "block";
            return;
        }

        // Derive success from the COMPUTED overall tree status, not the bare
        // root status. The root PREPARE_FOR_GENERATION is a no-op that is marked
        // COMPLETED the instant it exits, so payload.status reads COMPLETED even
        // when a descendant (e.g. Map Topics With Content) failed — which is how
        // the green "complete" banner used to show on top of a red "Failed 63%"
        // tree. getOverallStatus() rolls up every node and returns FAILED if any
        // node failed, so the banner now agrees with what the tree shows.
        const bSuccess = this.#getProgressComponent().getOverallStatus() === taskStatus.COMPLETED;

        if (bSuccess)
        {
            statusBanner.textContent = "Generation complete — your decks are ready.";
            statusBanner.classList.add("progress-page-status-banner--success");
        }
        else
        {
            // Surface the actual reason recorded on the failed task (e.g. the
            // topic-matching error) so the user sees WHY it failed, not just that
            // it did. Falls back to the generic line when no message was recorded.
            const failureMessage = this.#getProgressComponent().getFirstFailureMessage();
            statusBanner.textContent = failureMessage
                ? `Generation failed: ${failureMessage}`
                : "Generation failed. Please try again.";
            statusBanner.classList.add("progress-page-status-banner--error");
        }

        statusBanner.style.display = "block";
    }

    /**
     * Renders the partial-completion banner: a description of what was kept plus
     * a "keep them and retry the rest" button that re-runs only the failed
     * output types.
     * @param {object} partialCompletion
     */
    #renderPartialCompletion(partialCompletion)
    {
        const statusBanner = this.querySelector(".progress-page-status-banner");

        const description = PartialGenerationRetryFlow.describeKept(partialCompletion);

        statusBanner.innerHTML =
        `
            <span class="progress-page-partial-text">${ProgressPage.#escape(description)}</span>
            <button class="progress-page-partial-retry-button" type="button" style="margin-left: 10px; padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 13px; background: var(--primary-background-gradient); color: var(--primary-text-color);">Keep &amp; retry the rest</button>
        `;
        statusBanner.classList.add("progress-page-status-banner--error");
        statusBanner.style.display = "block";

        const retryButton = statusBanner.querySelector(".progress-page-partial-retry-button");
        if (retryButton)
        {
            retryButton.addEventListener("click", () =>
            {
                retryButton.disabled = true;
                PartialGenerationRetryFlow.retry(partialCompletion).catch(retryError =>
                {
                    console.error("[ProgressPage] partial retry error:", retryError);
                    retryButton.disabled = false;
                });
            });
        }
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
        if (payload.partialCompletion)
        {
            // An archived partial run — still continuable from Activity.
            this.#renderPartialCompletion(payload.partialCompletion);
        }
        else if (payload.status === taskStatus.FAILED)
        {
            statusBanner.textContent = "This task ended with a failure.";
            statusBanner.classList.add("progress-page-status-banner--error");
            statusBanner.style.display = "block";
        }
        else
        {
            statusBanner.textContent = "This task has been completed.";
            statusBanner.classList.add("progress-page-status-banner--success");
            statusBanner.style.display = "block";
        }

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

        // For an AI generation, append the per-task credit-spend breakdown
        // alongside the historical summary.
        if (payload && payload.type === taskTypes.PREPARE_FOR_GENERATION)
        {
            this.#renderCreditSummary(this.#taskId).catch(summaryError => console.error("[ProgressPage] credit summary error:", summaryError));
        }
    }

    /**
     * Fetches the per-task credit-spend breakdown for this generation and
     * appends it as a table. No-op when nothing was charged (older runs,
     * free config) or when the table is already present.
     * @param {string} mainTaskId
     */
    async #renderCreditSummary(mainTaskId)
    {
        // The tutorial demo never spends credits and has no real task, so
        // there is nothing to fetch — and fetching would contact the server.
        if (TutorialEngine.isRunning())
        {
            return;
        }

        if (!mainTaskId)
        {
            return;
        }

        const leftColumn = this.querySelector(".progress-page-left");
        if (!leftColumn || leftColumn.querySelector(".progress-page-credit-summary"))
        {
            return;
        }

        let summary;
        try
        {
            const response = await fetch(`/Activity/Tasks/CreditSummary?taskid=${encodeURIComponent(mainTaskId)}`);
            if (!response.ok)
            {
                return;
            }
            summary = await response.json();
        }
        catch (fetchError)
        {
            return;
        }

        if (!summary || !Array.isArray(summary.entries) || summary.entries.length === 0)
        {
            return;
        }

        // Guard against a late second call racing in after the await.
        if (leftColumn.querySelector(".progress-page-credit-summary"))
        {
            return;
        }

        leftColumn.insertAdjacentHTML("beforeend", ProgressPage.#buildCreditSummaryHtml(summary));
    }

    static #buildCreditSummaryHtml(summary)
    {
        const formatTokens = (value) => (typeof value === "number" && value > 0) ? value.toLocaleString() : "—";
        const formatDuration = (value) => (typeof value === "number" && value > 0) ? `${value}s` : "—";

        const rowsHtml = summary.entries.map((entry) =>
        {
            const label = taskTypeDisplayName(entry.taskType);
            return `
                <tr>
                    <td>${ProgressPage.#escape(label)}</td>
                    <td>${ProgressPage.#escape(entry.method || "—")}</td>
                    <td>${ProgressPage.#escape(formatCredits(entry.credits))}</td>
                    <td>${formatTokens(entry.inputTokens)}</td>
                    <td>${formatTokens(entry.outputTokens)}</td>
                    <td>${formatDuration(entry.durationSeconds)}</td>
                </tr>
            `;
        }).join("");

        return `
            <style>
                .progress-page-credit-summary { margin-top: 22px; }
                .progress-page-credit-table { width: 100%; border-collapse: collapse; font-size: 13px; }
                .progress-page-credit-table th,
                .progress-page-credit-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--outline-color-subtle); }
                .progress-page-credit-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--secondary-text-color); font-weight: 600; }
                .progress-page-credit-table td:nth-child(n+3),
                .progress-page-credit-table th:nth-child(n+3) { text-align: right; }
                .progress-page-credit-table .progress-page-credit-total td { font-weight: 700; color: var(--primary-text-color); border-bottom: none; border-top: 2px solid var(--outline-color); }
            </style>
            <div class="progress-page-credit-summary">
                <div class="progress-page-section-title">Credit usage</div>
                <table class="progress-page-credit-table">
                    <thead>
                        <tr>
                            <th>Task</th>
                            <th>Billed by</th>
                            <th>Credits</th>
                            <th>Input tokens</th>
                            <th>Output tokens</th>
                            <th>Duration</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHtml}
                        <tr class="progress-page-credit-total">
                            <td>Total</td>
                            <td>—</td>
                            <td>${ProgressPage.#escape(formatCredits(summary.totalCredits))}</td>
                            <td>—</td>
                            <td>—</td>
                            <td>—</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        `;
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
            // partialCompletion is surfaced as its own banner + retry button, not
            // as a raw JSON metadata row.
            if (key === "partialCompletion") continue;
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
        return taskTypeDisplayName(typeValue);
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

        const pauseButton = this.querySelector(".progress-page-pause-button");
        if (pauseButton)
        {
            pauseButton.addEventListener("click", () => { this.#handlePause(); });
        }
    }

    /**
     * Updates the in-progress notices: the amber "AI provider is busy" banner
     * (driven by the self-expiring providerSlowdown flag) and the "you can leave
     * and resume" line (driven by the live Redis TTL). Both auto-hide when their
     * underlying signal is absent, so a recovered provider clears the banner on
     * the next poll with no extra bookkeeping.
     * @param {object} payload
     */
    #updateLiveStatus(payload)
    {
        const liveBanner = this.querySelector(".progress-page-live-banner");
        if (liveBanner)
        {
            if (payload && payload.providerSlowdown === true)
            {
                liveBanner.textContent = "⚠ The AI provider is busy right now — generation is slower than usual but has not stopped.";
                liveBanner.style.display = "block";
            }
            else
            {
                liveBanner.style.display = "none";
            }
        }

        const ttlNote = this.querySelector(".progress-page-ttl-note");
        if (ttlNote)
        {
            const remainingText = ProgressPage.#formatRemainingCoarse(payload && payload.remainingTtlMillis);
            if (remainingText)
            {
                ttlNote.textContent = `You can safely leave this page — your progress is saved for about ${remainingText}. Reopen it from Activity to keep watching.`;
                ttlNote.style.display = "block";
            }
            else
            {
                ttlNote.style.display = "none";
            }
        }

        // Reveal Pause only for a live, still-running generation (whether opened
        // fresh after Generate or restored from Activity). Not for other task
        // types, paused runs, or terminal/historical views. Once "Pausing…" has
        // been clicked the button is disabled — leave its label alone then.
        const pauseButton = this.querySelector(".progress-page-pause-button");
        if (pauseButton && !pauseButton.disabled)
        {
            const bIsLiveGeneration = !!payload
                && payload.historical !== true
                && payload.paused !== true
                && payload.type === taskTypes.PREPARE_FOR_GENERATION
                && !this.#getProgressComponent().isTerminal();

            pauseButton.style.display = bIsLiveGeneration ? "inline-block" : "none";
        }
    }

    /**
     * Asks the server to pause this generation. The pause takes effect at the
     * next stage boundary (a running stage finishes first), so the button
     * reports "Pausing…" and stays disabled — the poll loop reflects the actual
     * paused state when the chain stops launching new tasks.
     */
    async #handlePause()
    {
        const pauseButton = this.querySelector(".progress-page-pause-button");
        if (!pauseButton || pauseButton.disabled)
        {
            return;
        }

        pauseButton.disabled = true;
        pauseButton.textContent = "Pausing…";

        try
        {
            const response = await fetch("/Generate/Pause",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ taskId: this.#taskId })
            });

            if (!response.ok)
            {
                console.warn(`[ProgressPage] Pause returned ${response.status}`);
                pauseButton.disabled = false;
                pauseButton.textContent = "Pause";
                return;
            }

            pauseButton.textContent = "Pausing after current step…";
        }
        catch (pauseError)
        {
            console.error("[ProgressPage] Pause error:", pauseError);
            pauseButton.disabled = false;
            pauseButton.textContent = "Pause";
        }
    }

    static #formatRemainingCoarse(rawMillis)
    {
        const millis = Number(rawMillis);
        if (!Number.isFinite(millis) || millis <= 0) return "";
        const totalMinutes = Math.floor(millis / 60000);
        if (totalMinutes <= 0) return "less than a minute";
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const parts = [];
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        return parts.join(" ");
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
                    <div class="progress-page-live-banner"></div>
                    <div class="progress-page-status-banner"></div>
                    <generation-progress-component></generation-progress-component>
                    <div class="progress-page-ttl-note"></div>
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
                <div class="progress-page-footer-actions">
                    <button class="progress-page-pause-button" type="button" style="display: none;">Pause</button>
                    <button class="progress-page-continue-button">Continue Studying →</button>
                </div>
            </div>
        `;

        this.#handleEvents();

        // Tutorial demo runs entirely client-side — no notifier tracking,
        // no polling, no server.
        if (TutorialEngine.isRunning())
        {
            this.#playTutorialDemo();
            return;
        }

        if (this.#taskId)
        {
            // A live generation tracked in the background as well, so the
            // completion notification still fires if the user navigates away
            // or backgrounds the tab. Historical/Activity views (a different
            // endpoint) are already terminal and must not be tracked.
            if (this.#endpointUrl === DEFAULT_PROGRESS_ENDPOINT)
            {
                // Pass an empty label deliberately: when generation was started
                // from AutomaticGenerationPage it already tracked this task with
                // the real subject name, and track() keeps the first non-empty
                // label — so an empty label here preserves the subject. When the
                // ProgressPage is reached without a prior track (no existing
                // entry), track() supplies its own "Your generation" default.
                GenerationNotifier.track(this.#taskId, "");
                GenerationNotifier.setForegroundTask(this.#taskId);
            }

            this.#startPolling();
        }
    }

    disconnectedCallback()
    {
        this.#stopPolling();
        if (this.#demoTimeoutId !== null)
        {
            clearTimeout(this.#demoTimeoutId);
            this.#demoTimeoutId = null;
        }
        if (this.#taskId)
        {
            GenerationNotifier.clearForegroundTask(this.#taskId);
        }
    }
}

customElements.define("progress-page", ProgressPage);
export default ProgressPage;
