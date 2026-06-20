import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { browserLlmDownloadStates } from "../../../Globals/Enumerations/BrowserLlmDownloadStates.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import BrowserLlmDownloadConstants from "../../../Globals/Constants/BrowserLlmDownloadConstants.js";
import BrowserLlmCapability from "../../../Globals/Classes/BrowserLlm/BrowserLlmCapability.js";
import BrowserLlmDownloadManager from "../../../Globals/Classes/BrowserLlm/BrowserLlmDownloadManager.js";


/**
 * LocalDownloadActivitySource
 *
 * Adapts the per-device BrowserLlm download state into a synthetic
 * activity entry that the ActivityPage and ActivityPreviewComponent can
 * splice into their server-fetched list. The server has no knowledge of
 * this download — it's a client-side asset cache — so we surface it
 * locally only.
 *
 * Entries are emitted only when the user is actively engaged with the
 * download (DOWNLOADING / DECLINED / FAILED). NOT_STARTED, READY, and
 * UNSUPPORTED don't yield an entry — there's no actionable item to
 * show in the feed for those states.
 *
 * Status mapping mirrors `taskStatus` so the existing
 * ActivityEntryComponent renders the correct colour without bespoke
 * styling:
 *
 *   DOWNLOADING → IN_PROGRESS  (neutral / accent badge)
 *   FAILED      → FAILED
 *   DECLINED    → IN_PROGRESS (treated as "still pending user action")
 */
class LocalDownloadActivitySource
{
    static #ENTRY_ID_PREFIX = "browser-llm-download";

    /**
     * Returns the synthetic entry for the current state, or `null`
     * when there's nothing to show.
     */
    static getEntry()
    {
        const currentState = BrowserLlmCapability.getState();

        if (currentState !== browserLlmDownloadStates.DOWNLOADING
            && currentState !== browserLlmDownloadStates.FAILED
            && currentState !== browserLlmDownloadStates.DECLINED)
        {
            return null;
        }

        const completionFraction = BrowserLlmCapability.getProgressFraction();
        const startedAt = BrowserLlmDownloadManager.getDownloadStartedAt();
        const timestampIso = (startedAt ? new Date(startedAt) : new Date()).toISOString();

        return {
            id: LocalDownloadActivitySource.#ENTRY_ID_PREFIX,
            entryType: activityEntryTypes.DOWNLOAD,
            title: "Offline AI model",
            subtitle: LocalDownloadActivitySource.#subtitleFor(currentState, completionFraction),
            status: LocalDownloadActivitySource.#statusFor(currentState),
            timestamp: timestampIso,
            payload:
            {
                completion: completionFraction,
                isLive: currentState === browserLlmDownloadStates.DOWNLOADING,
                modelId: BrowserLlmDownloadConstants.MODEL_ID,
                downloadState: currentState
            }
        };
    }

    /**
     * Returns true when the local entry should be visible given the
     * caller's `includeTypes` filter. ActivityPage uses this so the
     * Downloads tab gets the entry only when filtered to DOWNLOAD or
     * left unfiltered.
     */
    static matchesIncludeTypes(includeTypes)
    {
        if (!Array.isArray(includeTypes) || includeTypes.length === 0)
        {
            return true;
        }
        return includeTypes.includes(activityEntryTypes.DOWNLOAD);
    }

    static #subtitleFor(currentState, completionFraction)
    {
        if (currentState === browserLlmDownloadStates.DOWNLOADING)
        {
            const percent = Math.round(Math.max(0, Math.min(1, completionFraction)) * 100);
            return `Downloading… ${percent}%`;
        }
        if (currentState === browserLlmDownloadStates.FAILED)
        {
            return "Download failed — retry from the model picker";
        }
        if (currentState === browserLlmDownloadStates.DECLINED)
        {
            return "Declined — retry from the model picker";
        }
        return "";
    }

    static #statusFor(currentState)
    {
        if (currentState === browserLlmDownloadStates.FAILED)
        {
            return taskStatus.FAILED;
        }
        // DOWNLOADING + DECLINED both surface as "in progress" so the
        // status colour stays neutral/active in the feed.
        return taskStatus.IN_PROGRESS;
    }
}

export default LocalDownloadActivitySource;
