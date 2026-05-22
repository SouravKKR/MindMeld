import ProgressTreeDialog from "../../../CommonComponents/ProgressTreeDialog.js";
import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { browserLlmDownloadStates } from "../../../Globals/Enumerations/BrowserLlmDownloadStates.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import BrowserLlmDownloadEvents from "../../../Globals/Events/BrowserLlmDownloadEvents.js";
import BrowserLlmCapability from "../../../Globals/Classes/BrowserLlm/BrowserLlmCapability.js";
import BrowserLlmDownloadManager from "../../../Globals/Classes/BrowserLlm/BrowserLlmDownloadManager.js";


/**
 * ActivityEntryComponent
 *
 * Single reusable row inside the Activity page list. Receives a
 * canonical Activity entry object via initialize() and renders an
 * icon, primary line, secondary line, and a trailing action button
 * that depends on the entry type:
 *
 *   - TASK → "View" → opens [ProgressTreeDialog] for that task id.
 *   - PURCHASE → "Invoice" → navigates to
 *     /PaidDecks/Purchases/Invoice?purchaseId=... in a new tab so the
 *     user can Ctrl+P → Save as PDF without leaving the Activity page.
 *
 * Status colour comes from the canonical entry's `status` field, which
 * carries the matching enum value (taskStatus for tasks, purchaseStatus
 * for purchases — both are independent enums and read as opaque ints
 * here).
 */
class ActivityEntryComponent extends HTMLElement
{
    #entry = null;
    #boundDownloadProgressHandler = null;
    #boundDownloadCapabilityHandler = null;

    initialize(entry)
    {
        this.#entry = entry;
    }

    connectedCallback()
    {
        if (this.#entry === null)
        {
            this.innerHTML = "";
            return;
        }
        this.#render();

        // DOWNLOAD entries are live — subscribe to progress + capability
        // changes so the row re-renders without waiting for the parent
        // ActivityPage's debounced refresh.
        if (this.#entry.entryType === activityEntryTypes.DOWNLOAD)
        {
            this.#boundDownloadProgressHandler = () => this.#refreshDownloadEntry();
            this.#boundDownloadCapabilityHandler = () => this.#refreshDownloadEntry();
            window.addEventListener(BrowserLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);
            window.addEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
        }
    }

    disconnectedCallback()
    {
        if (this.#boundDownloadProgressHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);
            this.#boundDownloadProgressHandler = null;
        }
        if (this.#boundDownloadCapabilityHandler)
        {
            window.removeEventListener(BrowserLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
            this.#boundDownloadCapabilityHandler = null;
        }
    }

    #refreshDownloadEntry()
    {
        if (!this.#entry || this.#entry.entryType !== activityEntryTypes.DOWNLOAD)
        {
            return;
        }
        // Rebuild the in-memory entry from the current capability state
        // and re-render. The parent ActivityPage will eventually re-run
        // its search and replace this row entirely, but in the interim
        // the user sees live progress without a full refresh.
        const currentState = BrowserLlmCapability.getState();
        const percent = Math.round(Math.max(0, Math.min(1, BrowserLlmCapability.getProgressFraction())) * 100);

        const subtitleByState =
        {
            [browserLlmDownloadStates.DOWNLOADING]: `Downloading… ${percent}%`,
            [browserLlmDownloadStates.FAILED]:      "Download failed — retry from the model picker",
            [browserLlmDownloadStates.DECLINED]:    "Declined — retry from the model picker",
            [browserLlmDownloadStates.READY]:       "Ready",
            [browserLlmDownloadStates.NOT_STARTED]: "Not started",
            [browserLlmDownloadStates.UNSUPPORTED]: "Not supported on this device",
        };
        this.#entry.subtitle = subtitleByState[currentState] ?? this.#entry.subtitle;
        this.#entry.payload = { ...(this.#entry.payload || {}), completion: percent / 100, downloadState: currentState };
        this.#render();
    }

    #render()
    {
        const entry = this.#entry;
        const isTask = entry.entryType === activityEntryTypes.TASK;
        const isPurchase = entry.entryType === activityEntryTypes.PURCHASE;
        const isDownload = entry.entryType === activityEntryTypes.DOWNLOAD;
        const iconText = isTask ? "⚙" : isPurchase ? "✓" : "⬇";
        const iconKind = isTask ? "task" : isPurchase ? "purchase" : "download";
        const timestampLabel = ActivityEntryComponent.#formatTimestamp(entry.timestamp);
        const actionLabel = isTask ? "View" : isPurchase ? "Invoice" : ActivityEntryComponent.#downloadActionLabel(entry);
        const statusClass = ActivityEntryComponent.#statusClass(entry);

        this.innerHTML = `
            <div class="activity-entry">
                <div class="activity-entry-icon activity-entry-icon-${iconKind}">${iconText}</div>
                <div class="activity-entry-body">
                    <div class="activity-entry-title">${ActivityEntryComponent.#escape(entry.title || "")}</div>
                    <div class="activity-entry-subtitle">
                        <span class="activity-entry-status ${statusClass}">${ActivityEntryComponent.#escape(entry.subtitle || "")}</span>
                        <span class="activity-entry-timestamp">${ActivityEntryComponent.#escape(timestampLabel)}</span>
                    </div>
                </div>
                <button type="button" class="activity-entry-action" data-role="action">${ActivityEntryComponent.#escape(actionLabel)}</button>
            </div>
        `;

        this.querySelector('[data-role="action"]').addEventListener("click", () =>
        {
            this.#handleAction();
        });
    }

    static #downloadActionLabel(entry)
    {
        const downloadState = entry.payload?.downloadState ?? BrowserLlmCapability.getState();
        if (downloadState === browserLlmDownloadStates.DOWNLOADING)
        {
            return "Cancel";
        }
        if (downloadState === browserLlmDownloadStates.FAILED
            || downloadState === browserLlmDownloadStates.DECLINED)
        {
            return "Retry";
        }
        return "View";
    }

    #handleAction()
    {
        const entry = this.#entry;
        if (entry.entryType === activityEntryTypes.TASK)
        {
            ProgressTreeDialog.show(entry.id);
            return;
        }
        if (entry.entryType === activityEntryTypes.PURCHASE)
        {
            const invoiceUrl = `/PaidDecks/Purchases/Invoice?purchaseId=${encodeURIComponent(entry.id)}`;
            window.open(invoiceUrl, "_blank", "noopener");
            return;
        }
        if (entry.entryType === activityEntryTypes.DOWNLOAD)
        {
            const downloadState = entry.payload?.downloadState ?? BrowserLlmCapability.getState();
            if (downloadState === browserLlmDownloadStates.DOWNLOADING)
            {
                BrowserLlmDownloadManager.cancel();
                return;
            }
            if (downloadState === browserLlmDownloadStates.FAILED
                || downloadState === browserLlmDownloadStates.DECLINED
                || downloadState === browserLlmDownloadStates.NOT_STARTED)
            {
                BrowserLlmDownloadManager.start();
                return;
            }
        }
    }

    static #statusClass(entry)
    {
        if (entry.entryType !== activityEntryTypes.TASK
            && entry.entryType !== activityEntryTypes.DOWNLOAD)
        {
            return "activity-entry-status-neutral";
        }
        if (entry.status === taskStatus.COMPLETED)
        {
            return "activity-entry-status-completed";
        }
        if (entry.status === taskStatus.FAILED)
        {
            return "activity-entry-status-failed";
        }
        if (entry.status === taskStatus.IN_PROGRESS)
        {
            return "activity-entry-status-in-progress";
        }
        return "activity-entry-status-neutral";
    }

    static #formatTimestamp(rawTimestamp)
    {
        if (!rawTimestamp)
        {
            return "";
        }
        try
        {
            const date = new Date(rawTimestamp);
            if (Number.isNaN(date.getTime()))
            {
                return "";
            }
            return date.toLocaleString();
        }
        catch (formatError)
        {
            return "";
        }
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
}

customElements.define("activity-entry-component", ActivityEntryComponent);
export default ActivityEntryComponent;
