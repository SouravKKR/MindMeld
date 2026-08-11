import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { localLlmDownloadStates } from "../../../Globals/Enumerations/LocalLlmDownloadStates.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import LocalLlmDownloadEvents from "../../../Globals/Events/LocalLlmDownloadEvents.js";
import LocalLlmCapability from "../../../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmDownloadManager from "../../../Globals/Classes/LocalLlm/LocalLlmDownloadManager.js";
import PaidDeckUploadEvents from "../../../Globals/Events/PaidDeckUploadEvents.js";
import PaidDeckUploadActivitySource from "../Sources/PaidDeckUploadActivitySource.js";


/**
 * ActivityEntryComponent
 *
 * Single reusable row inside the Activity page list. Receives a
 * canonical Activity entry object via initialize() and renders an
 * icon, primary line, secondary line, and a trailing action button
 * that depends on the entry type:
 *
 *   - TASK → "View" → navigates to the [progress-page] for that task
 *     id, pointing at the Activity progress endpoint so both live tasks
 *     and finished (historical) tasks render correctly.
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
    #boundUploadProgressHandler = null;

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
            window.addEventListener(LocalLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);
            window.addEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
        }

        // UPLOAD entries are live too — re-render from the client-side upload
        // source on each progress event so the row tracks the upload.
        if (this.#entry.entryType === activityEntryTypes.UPLOAD)
        {
            this.#boundUploadProgressHandler = () => this.#refreshUploadEntry();
            window.addEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);
        }
    }

    disconnectedCallback()
    {
        if (this.#boundDownloadProgressHandler)
        {
            window.removeEventListener(LocalLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);
            this.#boundDownloadProgressHandler = null;
        }
        if (this.#boundDownloadCapabilityHandler)
        {
            window.removeEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
            this.#boundDownloadCapabilityHandler = null;
        }
        if (this.#boundUploadProgressHandler)
        {
            window.removeEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);
            this.#boundUploadProgressHandler = null;
        }
    }

    #refreshUploadEntry()
    {
        if (!this.#entry || this.#entry.entryType !== activityEntryTypes.UPLOAD)
        {
            return;
        }
        // Re-read the live entry from the source. When the upload has cleared
        // the source returns null; keep the last render in that case — the
        // parent ActivityPage drops the row on the same event.
        const freshEntry = PaidDeckUploadActivitySource.getEntry();
        if (freshEntry)
        {
            this.#entry = freshEntry;
            this.#render();
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
        const currentState = LocalLlmCapability.getState();
        const percent = Math.round(Math.max(0, Math.min(1, LocalLlmCapability.getProgressFraction())) * 100);

        const subtitleByState =
        {
            [localLlmDownloadStates.DOWNLOADING]: `Downloading… ${percent}%`,
            [localLlmDownloadStates.FAILED]:      "Download failed — retry from the model picker",
            [localLlmDownloadStates.DECLINED]:    "Declined — retry from the model picker",
            [localLlmDownloadStates.READY]:       "Ready",
            [localLlmDownloadStates.NOT_STARTED]: "Not started",
            [localLlmDownloadStates.UNSUPPORTED]: "Not supported on this device",
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
        const isUpload = entry.entryType === activityEntryTypes.UPLOAD;
        const iconText = isTask ? "⚙" : isPurchase ? "✓" : isUpload ? "⬆" : "⬇";
        // Upload reuses the task icon styling (no bespoke CSS needed).
        const iconKind = isTask || isUpload ? "task" : isPurchase ? "purchase" : "download";
        const timestampLabel = ActivityEntryComponent.#formatTimestamp(entry.timestamp);
        // The upload is a fire-and-forget client operation — no row action.
        const actionLabel = isUpload ? "" : isTask ? "View" : isPurchase ? "Invoice" : ActivityEntryComponent.#downloadActionLabel(entry);
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
                ${actionLabel ? `<button type="button" class="activity-entry-action" data-role="action">${ActivityEntryComponent.#escape(actionLabel)}</button>` : ""}
            </div>
        `;

        const actionButton = this.querySelector('[data-role="action"]');
        if (actionButton)
        {
            actionButton.addEventListener("click", () =>
            {
                this.#handleAction();
            });
        }
    }

    static #downloadActionLabel(entry)
    {
        const downloadState = entry.payload?.downloadState ?? LocalLlmCapability.getState();
        if (downloadState === localLlmDownloadStates.DOWNLOADING)
        {
            return "Cancel";
        }
        if (downloadState === localLlmDownloadStates.FAILED
            || downloadState === localLlmDownloadStates.DECLINED)
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
            PageNavigator.open("progress-page", entry.id,
            {
                endpointUrl: "/Activity/Tasks/Progress",
                title: "Task progress",
                continueBehavior: "back"
            });
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
            const downloadState = entry.payload?.downloadState ?? LocalLlmCapability.getState();
            if (downloadState === localLlmDownloadStates.DOWNLOADING)
            {
                LocalLlmDownloadManager.cancel();
                return;
            }
            if (downloadState === localLlmDownloadStates.FAILED
                || downloadState === localLlmDownloadStates.DECLINED
                || downloadState === localLlmDownloadStates.NOT_STARTED)
            {
                LocalLlmDownloadManager.start();
                return;
            }
        }
    }

    static #statusClass(entry)
    {
        if (entry.entryType !== activityEntryTypes.TASK
            && entry.entryType !== activityEntryTypes.DOWNLOAD
            && entry.entryType !== activityEntryTypes.UPLOAD)
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
