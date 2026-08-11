import PageNavigator from "../../../Globals/Classes/PageNavigator.js";
import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import LocalLlmDownloadEvents from "../../../Globals/Events/LocalLlmDownloadEvents.js";
import PaidDeckUploadEvents from "../../../Globals/Events/PaidDeckUploadEvents.js";
import LocalDownloadActivitySource from "../../Activity/Sources/LocalDownloadActivitySource.js";
import PaidDeckUploadActivitySource from "../../Activity/Sources/PaidDeckUploadActivitySource.js";


/**
 * ActivityPreviewComponent
 *
 * Single "View Activity" hyperlink shown in the logged-in
 * HomeFooterComponent — it occupies the same slot the Terms of Service
 * / Privacy Policy hyperlinks occupy when logged out, with the same
 * inline text styling, so the footer band looks consistent across auth
 * states.
 *
 * One click target, one label. When generation tasks are running the
 * link grows a small badge with the count and the top task's
 * completion percent so users notice live work without introducing a
 * second button. Clicking anywhere on the link navigates to the
 * Activity page where the per-task progress dialog is reachable from
 * the entry row.
 *
 * Polls POST /Activity/Search restricted to TASK + IN_PROGRESS every
 * #POLL_INTERVAL_MILLIS to keep the badge fresh. Polling pauses when
 * the document is hidden and tears down on disconnection.
 */
class ActivityPreviewComponent extends HTMLElement
{
    static #POLL_INTERVAL_MILLIS = 4000;
    static #ENDPOINT = "/Activity/Search";

    #pollTimeoutId = null;
    #boundHandleVisibility = null;
    #boundDownloadCapabilityHandler = null;
    #boundDownloadProgressHandler = null;
    #boundUploadProgressHandler = null;
    #latestEntries = [];
    #bDisposed = false;

    connectedCallback()
    {
        this.innerHTML = `
            <button type="button" class="activity-preview-button" data-role="button">
                <span class="activity-preview-label">View Activity</span>
                <span class="activity-preview-badge" data-role="badge" hidden></span>
            </button>
        `;

        this.querySelector('[data-role="button"]').addEventListener("click", () =>
        {
            PageNavigator.open("activity-page");
        });

        this.#boundHandleVisibility = () => this.#handleVisibilityChange();
        document.addEventListener("visibilitychange", this.#boundHandleVisibility);

        // Local download events drive the badge directly — no need to
        // wait for the next 4-second poll. The events surface state
        // transitions and live progress on their own.
        this.#boundDownloadCapabilityHandler = () => this.#renderBadge();
        this.#boundDownloadProgressHandler   = () => this.#renderBadge();
        window.addEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
        window.addEventListener(LocalLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);

        // Local paid-deck upload drives the badge the same way downloads do.
        this.#boundUploadProgressHandler = () => this.#renderBadge();
        window.addEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);

        this.#pollOnce();
    }

    disconnectedCallback()
    {
        this.#bDisposed = true;
        if (this.#pollTimeoutId !== null)
        {
            clearTimeout(this.#pollTimeoutId);
            this.#pollTimeoutId = null;
        }
        if (this.#boundHandleVisibility !== null)
        {
            document.removeEventListener("visibilitychange", this.#boundHandleVisibility);
        }
        if (this.#boundDownloadCapabilityHandler !== null)
        {
            window.removeEventListener(LocalLlmDownloadEvents.CAPABILITY_CHANGED, this.#boundDownloadCapabilityHandler);
            this.#boundDownloadCapabilityHandler = null;
        }
        if (this.#boundDownloadProgressHandler !== null)
        {
            window.removeEventListener(LocalLlmDownloadEvents.PROGRESS, this.#boundDownloadProgressHandler);
            this.#boundDownloadProgressHandler = null;
        }
        if (this.#boundUploadProgressHandler !== null)
        {
            window.removeEventListener(PaidDeckUploadEvents.PROGRESS, this.#boundUploadProgressHandler);
            this.#boundUploadProgressHandler = null;
        }
    }

    #handleVisibilityChange()
    {
        if (document.visibilityState === "hidden")
        {
            if (this.#pollTimeoutId !== null)
            {
                clearTimeout(this.#pollTimeoutId);
                this.#pollTimeoutId = null;
            }
        }
        else if (!this.#bDisposed && this.#pollTimeoutId === null)
        {
            this.#pollOnce();
        }
    }

    async #pollOnce()
    {
        if (this.#bDisposed)
        {
            return;
        }

        try
        {
            const response = await fetch(ActivityPreviewComponent.#ENDPOINT,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify
                ({
                    includeTypes: [activityEntryTypes.TASK],
                    filters: { status: taskStatus.IN_PROGRESS },
                    sort: { field: 0, direction: -1 },
                    limit: 5,
                    offset: 0
                })
            });

            if (this.#bDisposed)
            {
                return;
            }

            if (response.ok)
            {
                const responseJson = await response.json();
                this.#latestEntries = Array.isArray(responseJson.entries) ? responseJson.entries : [];
                this.#renderBadge();
            }
        }
        catch (pollError)
        {
            console.warn(`[ActivityPreview] poll failed: ${pollError.message}`);
        }

        if (!this.#bDisposed)
        {
            this.#pollTimeoutId = setTimeout(() => this.#pollOnce(), ActivityPreviewComponent.#POLL_INTERVAL_MILLIS);
        }
    }

    #renderBadge()
    {
        const badgeElement = this.querySelector('[data-role="badge"]');
        if (badgeElement === null)
        {
            return;
        }

        const inProgressEntries = this.#latestEntries.filter((entry) =>
        {
            return entry.entryType === activityEntryTypes.TASK && entry.status === taskStatus.IN_PROGRESS;
        });

        // Splice in the local browser-LLM download as an in-progress
        // entry when it's actively running. The local source returns
        // null otherwise, which leaves the badge driven purely by
        // server-side tasks.
        const localDownloadEntry = LocalDownloadActivitySource.getEntry();
        if (localDownloadEntry !== null
            && localDownloadEntry.payload?.isLive === true)
        {
            inProgressEntries.unshift(localDownloadEntry);
        }

        // Same for an in-progress paid-deck upload.
        const localUploadEntry = PaidDeckUploadActivitySource.getEntry();
        if (localUploadEntry !== null
            && localUploadEntry.payload?.isLive === true)
        {
            inProgressEntries.unshift(localUploadEntry);
        }

        if (inProgressEntries.length === 0)
        {
            badgeElement.hidden = true;
            badgeElement.textContent = "";
            return;
        }

        const topEntry = inProgressEntries[0];
        const completion = (topEntry.payload && typeof topEntry.payload.completion === "number") ? topEntry.payload.completion : 0;
        const percent = Math.round(Math.max(0, Math.min(1, completion)) * 100);
        const taskCount = inProgressEntries.length;

        badgeElement.hidden = false;
        badgeElement.textContent = taskCount === 1
            ? `${percent}%`
            : `${taskCount} • ${percent}%`;
    }
}

customElements.define("activity-preview-component", ActivityPreviewComponent);
export default ActivityPreviewComponent;
