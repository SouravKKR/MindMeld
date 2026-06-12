import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import PaidDeckUploadEvents from "../../../Globals/Events/PaidDeckUploadEvents.js";

/**
 * PaidDeckUploadActivitySource
 *
 * Client-side activity source for the admin paid-deck upload, mirroring
 * LocalDownloadActivitySource. A paid-deck upload is a sequential multi-POST
 * the server never tracks as a Task, so we hold its progress in a static
 * here and surface it as a synthetic activity entry that the ActivityPage and
 * ActivityPreview can splice into their server-fetched lists.
 *
 * The upload dialog drives this via begin() / update() / finish(); each call
 * fires PaidDeckUploadEvents.PROGRESS so the activity surfaces re-render
 * without waiting for their next poll. The terminal (completed / failed)
 * entry lingers briefly so the user sees the outcome, then clears.
 */
class PaidDeckUploadActivitySource
{
    static #ENTRY_ID = "paid-deck-upload";
    static #LINGER_MILLISECONDS = 5000;

    // { title, completedCount, totalCount, status, statusText, startedAtIso } | null
    static #current = null;
    static #clearTimeoutId = null;

    static begin(title, totalCount)
    {
        if (PaidDeckUploadActivitySource.#clearTimeoutId !== null)
        {
            clearTimeout(PaidDeckUploadActivitySource.#clearTimeoutId);
            PaidDeckUploadActivitySource.#clearTimeoutId = null;
        }
        PaidDeckUploadActivitySource.#current =
        {
            title: (typeof title === "string" && title.length > 0) ? title : "Uploading paid deck",
            completedCount: 0,
            totalCount: Math.max(1, Number(totalCount) || 1),
            status: taskStatus.IN_PROGRESS,
            statusText: "",
            startedAtIso: new Date().toISOString()
        };
        PaidDeckUploadActivitySource.#emit();
    }

    static update(completedCount, statusText)
    {
        const current = PaidDeckUploadActivitySource.#current;
        if (!current)
        {
            return;
        }
        current.completedCount = Math.max(0, Math.min(current.totalCount, Number(completedCount) || 0));
        if (typeof statusText === "string")
        {
            current.statusText = statusText;
        }
        PaidDeckUploadActivitySource.#emit();
    }

    static finish(bSuccess)
    {
        const current = PaidDeckUploadActivitySource.#current;
        if (!current)
        {
            return;
        }
        current.status = bSuccess ? taskStatus.COMPLETED : taskStatus.FAILED;
        if (bSuccess)
        {
            current.completedCount = current.totalCount;
        }
        PaidDeckUploadActivitySource.#emit();

        // Keep the terminal entry visible briefly, then drop it.
        PaidDeckUploadActivitySource.#clearTimeoutId = setTimeout(() =>
        {
            if (PaidDeckUploadActivitySource.#current === current)
            {
                PaidDeckUploadActivitySource.#current = null;
                PaidDeckUploadActivitySource.#emit();
            }
            PaidDeckUploadActivitySource.#clearTimeoutId = null;
        }, PaidDeckUploadActivitySource.#LINGER_MILLISECONDS);
    }

    /**
     * Returns the synthetic activity entry for the in-progress / just-finished
     * upload, or null when there's nothing to show.
     */
    static getEntry()
    {
        const current = PaidDeckUploadActivitySource.#current;
        if (!current)
        {
            return null;
        }
        const completion = current.completedCount / current.totalCount;
        return {
            id: PaidDeckUploadActivitySource.#ENTRY_ID,
            entryType: activityEntryTypes.UPLOAD,
            title: current.title,
            subtitle: PaidDeckUploadActivitySource.#subtitleFor(current, completion),
            status: current.status,
            timestamp: current.startedAtIso,
            payload:
            {
                completion: completion,
                isLive: current.status === taskStatus.IN_PROGRESS
            }
        };
    }

    static matchesIncludeTypes(includeTypes)
    {
        if (!Array.isArray(includeTypes) || includeTypes.length === 0)
        {
            return true;
        }
        return includeTypes.includes(activityEntryTypes.UPLOAD);
    }

    static #subtitleFor(current, completion)
    {
        if (current.status === taskStatus.FAILED)
        {
            return "Upload failed";
        }
        if (current.status === taskStatus.COMPLETED)
        {
            return "Upload complete";
        }
        const percent = Math.round(Math.max(0, Math.min(1, completion)) * 100);
        return current.statusText
            ? `${current.statusText} — ${percent}%`
            : `Uploading… ${percent}%`;
    }

    static #emit()
    {
        window.dispatchEvent(new CustomEvent(PaidDeckUploadEvents.PROGRESS));
    }
}

export default PaidDeckUploadActivitySource;
