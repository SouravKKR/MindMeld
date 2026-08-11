import { activityEntryTypes } from "../../../Globals/Enumerations/ActivityEntryTypes.js";
import { localLlmDownloadStates } from "../../../Globals/Enumerations/LocalLlmDownloadStates.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import LocalLlmCapability from "../../../Globals/Classes/LocalLlm/LocalLlmCapability.js";
import LocalLlmDownloadManager from "../../../Globals/Classes/LocalLlm/LocalLlmDownloadManager.js";


/**
 * LocalDownloadActivitySource
 *
 * Adapts the per-device LocalLlm download state into a synthetic
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
        const currentState = LocalLlmCapability.getState();

        if (currentState !== localLlmDownloadStates.DOWNLOADING
            && currentState !== localLlmDownloadStates.FAILED
            && currentState !== localLlmDownloadStates.DECLINED)
        {
            return null;
        }

        const completionFraction = LocalLlmCapability.getProgressFraction();
        const startedAt = LocalLlmDownloadManager.getDownloadStartedAt();
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
                isLive: currentState === localLlmDownloadStates.DOWNLOADING,
                // Which model this is depends on the device, so it is read
                // from the resolved selection rather than a fixed constant.
                modelId: LocalLlmCapability.getSelectedModelKey(),
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
        if (currentState === localLlmDownloadStates.DOWNLOADING)
        {
            const percent = Math.round(Math.max(0, Math.min(1, completionFraction)) * 100);
            return `Downloading… ${percent}%`;
        }
        if (currentState === localLlmDownloadStates.FAILED)
        {
            return "Download failed — retry from the model picker";
        }
        if (currentState === localLlmDownloadStates.DECLINED)
        {
            return "Declined — retry from the model picker";
        }
        return "";
    }

    static #statusFor(currentState)
    {
        if (currentState === localLlmDownloadStates.FAILED)
        {
            return taskStatus.FAILED;
        }
        // DOWNLOADING + DECLINED both surface as "in progress" so the
        // status colour stays neutral/active in the feed.
        return taskStatus.IN_PROGRESS;
    }
}

export default LocalDownloadActivitySource;
