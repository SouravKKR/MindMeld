import LogFormatter from "../../../Globals/Classes/Logging/LogFormatter.js";
import { logLevel } from "../../../Globals/Enumerations/LogLevel.js";
import { logCategory } from "../../../Globals/Enumerations/LogCategory.js";
import { adminListTypes } from "../../../Globals/Enumerations/AdminListTypes.js";

/**
 * AdminLogsPanel
 *
 * The admin Logs surface. It renders the central log as a colour-coded console
 * (requirement 10), backed by the same /Admin/Lists/Query endpoint as the generic
 * table (listKey LOGS) for history and by the Server-Sent-Events /Admin/Logs/Stream
 * for a live tail (requirement: watch logs in real time). It offers a multi-level
 * filter (requirement 5), date range, category and search, a frontend-only "Clear
 * screen" (requirement 9), a download with .log / .html format and optional split
 * (requirements 4/5), and the settable archival interval (requirement 7). The
 * layout is responsive for landscape and portrait (requirement 13).
 */
class AdminLogsPanel extends HTMLElement
{
    static #LEVEL_OPTIONS =
    [
        { value: logLevel.DEBUG, label: "Debug" },
        { value: logLevel.INFO, label: "Info" },
        { value: logLevel.WARNING, label: "Warning" },
        { value: logLevel.ERROR, label: "Error" }
    ];

    static #CATEGORY_OPTIONS =
    [
        { value: "", label: "All categories" },
        { value: logCategory.SYSTEM, label: "System" },
        { value: logCategory.AUTHENTICATION, label: "Authentication" },
        { value: logCategory.AI_REQUEST, label: "AI request" },
        { value: logCategory.PURCHASE, label: "Purchase" },
        { value: logCategory.EVENT, label: "Event" },
        { value: logCategory.ERROR, label: "Error" }
    ];

    // The console loads only the most recent N messages so the DOM never grows
    // unbounded. The default is the last 100 but the operator can edit it up to
    // the server-side ceiling (AdminListDefinition.MAX_LIMIT). Anything older than
    // this window is retrieved through the Download button, which merges the hot
    // MongoDB entries with the cold cloud-storage archives.
    static #DEFAULT_HISTORY_LIMIT = 100;
    static #MAXIMUM_HISTORY_LIMIT = 200;

    #eventSource = null;
    #consoleElement = null;

    connectedCallback()
    {
        this.innerHTML = `
            <style>
                admin-logs-panel { display: block; }

                .logs-toolbar
                {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 10px;
                    align-items: flex-end;
                    margin-bottom: 12px;
                }
                .logs-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--secondary-text-color, #b8b8c4); }
                .logs-field input, .logs-field select
                {
                    background: var(--secondary-background-color, #232330);
                    color: var(--primary-text-color, #f0f0f5);
                    border: 1px solid var(--outline-color, #3a3a4a);
                    border-radius: 6px;
                    padding: 6px 8px;
                    font-size: 13px;
                }
                .logs-levels { display: flex; gap: 10px; flex-wrap: wrap; }
                .logs-levels label { display: inline-flex; align-items: center; gap: 4px; color: var(--primary-text-color, #f0f0f5); font-size: 12px; }
                .logs-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
                .logs-button
                {
                    background: var(--accent-color, #2EB6E0);
                    color: #06131a;
                    border: none;
                    border-radius: 6px;
                    padding: 7px 12px;
                    font-size: 13px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .logs-button.secondary { background: var(--secondary-background-color, #232330); color: var(--primary-text-color, #f0f0f5); border: 1px solid var(--outline-color, #3a3a4a); }
                .logs-button.live-active { background: var(--status-failed, #DC5050); color: #fff; }

                .logs-console
                {
                    background: var(--primary-background-color, #14141b);
                    border: 1px solid var(--outline-color, #3a3a4a);
                    border-radius: 8px;
                    padding: 10px 12px;
                    height: 60vh;
                    overflow-y: auto;
                    font-family: "Consolas", "Menlo", monospace;
                    font-size: 12.5px;
                    line-height: 1.55;
                }
                .logs-console-line { white-space: pre-wrap; word-break: break-word; }
                .log-level-debug { color: var(--secondary-text-color, #8A8A99); }
                .log-level-info { color: var(--accent-color, #2EB6E0); }
                .log-level-warning { color: var(--highlight-color, #F5B838); }
                .log-level-error { color: var(--status-failed, #DC5050); font-weight: 600; }
                .logs-empty { color: var(--secondary-text-color, #8A8A99); }

                .logs-config { display: flex; gap: 8px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }

                @media (orientation: portrait), (max-width: 720px)
                {
                    .logs-toolbar { gap: 8px; }
                    .logs-field { flex: 1 1 46%; }
                    .logs-console { height: 55vh; font-size: 12px; }
                    .logs-buttons { width: 100%; }
                }
            </style>

            <div class="logs-toolbar">
                <div class="logs-field">
                    <span>Levels</span>
                    <div class="logs-levels" data-role="levels">
                        ${AdminLogsPanel.#LEVEL_OPTIONS.map(option => `<label><input type="checkbox" value="${option.value}" checked> ${option.label}</label>`).join("")}
                    </div>
                </div>
                <div class="logs-field">
                    <span>Category</span>
                    <select data-role="category">
                        ${AdminLogsPanel.#CATEGORY_OPTIONS.map(option => `<option value="${option.value}">${option.label}</option>`).join("")}
                    </select>
                </div>
                <div class="logs-field">
                    <span>From</span>
                    <input type="datetime-local" data-role="from">
                </div>
                <div class="logs-field">
                    <span>To</span>
                    <input type="datetime-local" data-role="to">
                </div>
                <div class="logs-field">
                    <span>Search</span>
                    <input type="text" data-role="search" placeholder="title, message, account…">
                </div>
                <div class="logs-field">
                    <span>Limit</span>
                    <input type="number" min="1" max="${AdminLogsPanel.#MAXIMUM_HISTORY_LIMIT}" value="${AdminLogsPanel.#DEFAULT_HISTORY_LIMIT}" data-role="limit" style="width: 90px;">
                </div>
                <div class="logs-field">
                    <span>Order</span>
                    <select data-role="order">
                        <option value="ascending">Oldest first</option>
                        <option value="descending">Newest first</option>
                    </select>
                </div>
                <div class="logs-buttons">
                    <button class="logs-button" data-role="refresh">Refresh</button>
                    <button class="logs-button secondary" data-role="live">Go Live</button>
                    <button class="logs-button secondary" data-role="clear">Clear screen</button>
                </div>
                <div class="logs-field">
                    <span>Format</span>
                    <select data-role="format">
                        <option value="log">.log (plain)</option>
                        <option value="html">.html (colour)</option>
                    </select>
                </div>
                <div class="logs-field">
                    <span>Split</span>
                    <select data-role="split-mode">
                        <option value="none">No split</option>
                        <option value="hours">By hours</option>
                        <option value="days">By days</option>
                        <option value="lines">By lines</option>
                    </select>
                </div>
                <div class="logs-field">
                    <span>Split amount</span>
                    <input type="number" min="1" value="24" data-role="split-amount">
                </div>
                <div class="logs-buttons">
                    <button class="logs-button" data-role="download">Download</button>
                </div>
            </div>

            <div class="logs-console" data-role="console"><div class="logs-empty">Loading logs…</div></div>

            <div class="logs-config">
                <div class="logs-field">
                    <span>Archive to cloud storage every (days)</span>
                    <input type="number" min="1" data-role="interval" style="width: 120px;">
                </div>
                <button class="logs-button secondary" data-role="save-interval">Save interval</button>
                <span class="logs-empty" data-role="interval-status"></span>
            </div>
        `;

        this.#consoleElement = this.querySelector('[data-role="console"]');

        this.querySelector('[data-role="refresh"]').addEventListener("click", () => this.#loadHistory());
        this.querySelector('[data-role="order"]').addEventListener("change", () => this.#loadHistory());
        this.querySelector('[data-role="limit"]').addEventListener("change", () => this.#loadHistory());
        this.querySelector('[data-role="live"]').addEventListener("click", (clickEvent) => this.#toggleLive(clickEvent.currentTarget));
        this.querySelector('[data-role="clear"]').addEventListener("click", () => this.#clearScreen());
        this.querySelector('[data-role="download"]').addEventListener("click", () => this.#download());
        this.querySelector('[data-role="save-interval"]').addEventListener("click", () => this.#saveInterval());

        this.#loadConfiguration();
        this.#loadHistory();
    }

    disconnectedCallback()
    {
        this.#stopLive();
    }

    #collectFilters()
    {
        const levels = Array.from(this.querySelectorAll('[data-role="levels"] input:checked')).map(input => Number(input.value));
        const categoryRaw = this.querySelector('[data-role="category"]').value;
        const category = categoryRaw === "" ? null : Number(categoryRaw);
        const search = this.querySelector('[data-role="search"]').value.trim();
        const fromValue = this.querySelector('[data-role="from"]').value;
        const toValue = this.querySelector('[data-role="to"]').value;

        return {
            levels: levels,
            category: category,
            search: search,
            fromDate: fromValue ? new Date(fromValue) : null,
            toDate: toValue ? new Date(toValue) : null
        };
    }

    #resolveLimit()
    {
        const requestedLimit = Number(this.querySelector('[data-role="limit"]').value) || AdminLogsPanel.#DEFAULT_HISTORY_LIMIT;
        return Math.min(Math.max(Math.floor(requestedLimit), 1), AdminLogsPanel.#MAXIMUM_HISTORY_LIMIT);
    }

    async #loadHistory()
    {
        const filters = this.#collectFilters();
        const limit = this.#resolveLimit();
        const order = this.querySelector('[data-role="order"]').value;
        const requestFilters = {};
        if (filters.levels.length > 0)
        {
            requestFilters.level = filters.levels;
        }
        if (filters.category !== null)
        {
            requestFilters.category = filters.category;
        }
        if (filters.fromDate || filters.toDate)
        {
            requestFilters.timestamp = {};
            if (filters.fromDate)
            {
                requestFilters.timestamp.from = filters.fromDate.toISOString();
            }
            if (filters.toDate)
            {
                requestFilters.timestamp.to = filters.toDate.toISOString();
            }
        }

        this.#consoleElement.innerHTML = `<div class="logs-empty">Loading logs…</div>`;

        try
        {
            const response = await fetch("/Admin/Lists/Query",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({
                    listKey: adminListTypes.LOGS,
                    search: filters.search,
                    filters: requestFilters,
                    // Always fetch the newest N (descending) so the window is the
                    // last N messages regardless of how they are then displayed.
                    sort: { field: "timestamp", direction: -1 },
                    limit: limit,
                    offset: 0,
                    context: {}
                })
            });
            const payload = await response.json();
            const newestFirstItems = Array.isArray(payload.items) ? payload.items : [];
            // Descending shows newest at the top; ascending reverses so the newest
            // sit at the bottom (the console-tail reading order).
            const items = order === "descending" ? newestFirstItems : newestFirstItems.slice().reverse();

            this.#consoleElement.innerHTML = "";
            if (items.length === 0)
            {
                this.#consoleElement.innerHTML = `<div class="logs-empty">No log entries match the current filters.</div>`;
                return;
            }
            for (const item of items)
            {
                this.#consoleElement.appendChild(this.#renderLine(item));
            }
            if (order === "descending")
            {
                this.#consoleElement.scrollTop = 0;
            }
            else
            {
                this.#scrollToBottom();
            }
        }
        catch (loadError)
        {
            this.#consoleElement.innerHTML = `<div class="logs-empty">Failed to load logs.</div>`;
        }
    }

    #buildStreamUrl()
    {
        const filters = this.#collectFilters();
        const parameters = new URLSearchParams();
        if (filters.levels.length > 0)
        {
            parameters.set("levels", filters.levels.join(","));
        }
        if (filters.category !== null)
        {
            parameters.set("categories", String(filters.category));
        }
        if (filters.search.length > 0)
        {
            parameters.set("search", filters.search);
        }
        return `/Admin/Logs/Stream?${parameters.toString()}`;
    }

    #toggleLive(buttonElement)
    {
        if (this.#eventSource)
        {
            this.#stopLive();
            buttonElement.textContent = "Go Live";
            buttonElement.classList.remove("live-active");
            return;
        }

        try
        {
            this.#eventSource = new EventSource(this.#buildStreamUrl());
            this.#eventSource.onmessage = (messageEvent) =>
            {
                try
                {
                    const payload = JSON.parse(messageEvent.data);
                    this.#consoleElement.appendChild(this.#renderLine(payload.entry, payload.formatted));
                    this.#scrollToBottom();
                }
                catch (parseError)
                {
                    // ignore malformed frame
                }
            };
            this.#eventSource.onerror = () => { /* EventSource auto-reconnects */ };
            buttonElement.textContent = "Stop Live";
            buttonElement.classList.add("live-active");
        }
        catch (streamError)
        {
            this.#eventSource = null;
        }
    }

    #stopLive()
    {
        if (this.#eventSource)
        {
            this.#eventSource.close();
            this.#eventSource = null;
        }
    }

    #renderLine(document, formatted)
    {
        const lineElement = window.document.createElement("div");
        lineElement.className = `logs-console-line ${LogFormatter.severityClassName(document ? document.level : logLevel.INFO)}`;
        lineElement.textContent = (formatted !== undefined && formatted !== null) ? formatted : LogFormatter.formatLine(document || {});
        return lineElement;
    }

    #scrollToBottom()
    {
        const nearBottom = (this.#consoleElement.scrollHeight - this.#consoleElement.scrollTop - this.#consoleElement.clientHeight) < 80;
        if (nearBottom)
        {
            this.#consoleElement.scrollTop = this.#consoleElement.scrollHeight;
        }
    }

    #clearScreen()
    {
        // Frontend only — never deletes from the database.
        this.#consoleElement.innerHTML = "";
    }

    #download()
    {
        const filters = this.#collectFilters();
        const parameters = new URLSearchParams();
        if (filters.fromDate)
        {
            parameters.set("fromDate", filters.fromDate.toISOString());
        }
        if (filters.toDate)
        {
            parameters.set("toDate", filters.toDate.toISOString());
        }
        if (filters.levels.length > 0)
        {
            parameters.set("levels", filters.levels.join(","));
        }

        const format = this.querySelector('[data-role="format"]').value;
        parameters.set("format", format);

        const splitMode = this.querySelector('[data-role="split-mode"]').value;
        if (splitMode !== "none")
        {
            const amount = Math.max(1, Number(this.querySelector('[data-role="split-amount"]').value) || 1);
            parameters.set("split", `${splitMode}:${amount}`);
        }

        const link = window.document.createElement("a");
        link.href = `/Admin/Logs/Download?${parameters.toString()}`;
        link.rel = "noopener";
        window.document.body.appendChild(link);
        link.click();
        link.remove();
    }

    async #loadConfiguration()
    {
        try
        {
            const response = await fetch("/Admin/Logs/Configuration", { credentials: "same-origin" });
            const payload = await response.json();
            const intervalInput = this.querySelector('[data-role="interval"]');
            if (payload && payload.configuration)
            {
                intervalInput.value = payload.configuration.archivalIntervalDays;
                const lastArchivedAt = payload.configuration.lastArchivedAt ? new Date(payload.configuration.lastArchivedAt).toLocaleString() : "never";
                this.querySelector('[data-role="interval-status"]').textContent = `Last archived: ${lastArchivedAt}`;
            }
        }
        catch (configError)
        {
            // leave the field blank
        }
    }

    async #saveInterval()
    {
        const intervalInput = this.querySelector('[data-role="interval"]');
        const statusElement = this.querySelector('[data-role="interval-status"]');
        const archivalIntervalDays = Math.max(1, Number(intervalInput.value) || 0);

        try
        {
            const response = await fetch("/Admin/Logs/Configuration/Save",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ archivalIntervalDays: archivalIntervalDays })
            });
            const payload = await response.json();
            if (response.ok && payload.configuration)
            {
                statusElement.textContent = payload.triggeredImmediateArchival ? "Saved — archiving now." : "Saved.";
            }
            else
            {
                statusElement.textContent = "Save failed.";
            }
        }
        catch (saveError)
        {
            statusElement.textContent = "Save failed.";
        }
    }
}

customElements.define("admin-logs-panel", AdminLogsPanel);

export default AdminLogsPanel;
