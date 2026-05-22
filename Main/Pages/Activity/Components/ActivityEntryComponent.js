import ProgressTreeDialog from "../../../CommonComponents/ProgressTreeDialog.js";
import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";


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
    }

    #render()
    {
        const entry = this.#entry;
        const isTask = entry.entryType === activityEntryTypes.TASK;
        const iconText = isTask ? "⚙" : "✓";
        const timestampLabel = ActivityEntryComponent.#formatTimestamp(entry.timestamp);
        const actionLabel = isTask ? "View" : "Invoice";
        const statusClass = ActivityEntryComponent.#statusClass(entry);

        this.innerHTML = `
            <div class="activity-entry">
                <div class="activity-entry-icon activity-entry-icon-${isTask ? "task" : "purchase"}">${iconText}</div>
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
        }
    }

    static #statusClass(entry)
    {
        if (entry.entryType !== activityEntryTypes.TASK)
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
