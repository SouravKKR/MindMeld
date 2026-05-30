import AutoAnalysisDeckFields from "./AutoAnalysisDeckFields.js";
import SyncEvents from "../../Events/SyncEvents.js";
import SyncOrchestrator from "../Syncing/SyncOrchestrator.js";
import { taskStatus } from "../../Enumerations/TaskStatus.js";


/**
 * Shared client-side runner for ANALYZE_DECK_PERFORMANCE tasks.
 *
 * The flow is the same whether the analysis is fired by the lazy
 * on-login dispatcher or by the explicit "Run analysis now" button:
 *
 *   1. (optionally) wipe the deck's previous analysis state +
 *      curated study materials so the new run replaces the old.
 *   2. POST /Analysis/QueueDeckAnalysis. The server enforces
 *      duplicate-detection: if an ANALYZE_DECK_PERFORMANCE task is
 *      already running for this (userId, deckId), its taskId is
 *      returned with `bAlreadyRunning: true` and the local kick
 *      transparently joins that run instead.
 *   3. Poll /Generate/Progress every 2 seconds until the task hits
 *      a terminal status (COMPLETED or FAILED). Each poll fires the
 *      caller's `onStatusChange` callback so a UI can render
 *      progress %.
 *   4. On COMPLETED, trigger a `SyncOrchestrator.sync` so the new
 *      `lastAnalysisTopics` field — written server-side by the
 *      workflow — is pulled to the client and the Insights page can
 *      re-render. The sync runs once per dispatcher cycle, not once
 *      per deck, so a bulk dispatch only pays the round-trip cost
 *      once.
 *
 * All public methods are static — there is no per-instance state and
 * concurrent callers are intentionally independent.
 */
class AnalysisTaskRunner
{
    static POLL_INTERVAL_MILLISECONDS = 2000;
    static MAX_POLL_DURATION_MILLISECONDS = 5 * 60 * 1000;
    static QUEUE_ENDPOINT    = "/Analysis/QueueDeckAnalysis";
    static PROGRESS_ENDPOINT = "/Generate/Progress";

    /**
     * Queues (or joins) an analysis run for the given deck and polls
     * it to completion.
     *
     * @param {Deck} deck — the deck to analyse.
     * @param {{
     *     bClearPreviousFirst?: boolean,   // wipe lastAnalysisTopics + curated materials before queueing
     *     bTriggerSync?: boolean,          // run SyncOrchestrator.sync on COMPLETED (default true)
     *     force?: boolean,                 // bypass the agent's LIVE-batch engagement check (manual Regenerate path)
     *     skipAnalysis?: boolean,          // skip the LLM topic-detection pass and use regenerateTopics directly
     *     regenerateTopics?: object[],     // [{name, strength, reason?, topicIndex?, hardCards?}] — used when skipAnalysis is true
     *     onStatusChange?: function|null   // called with {phase, taskTree?, error?, bAlreadyRunning?}
     * }} options
     * @returns {Promise<{taskTree: object, status: number, bAlreadyRunning: boolean}>}
     */
    static async queueAndTrack(deck, options = {})
    {
        const bClearPreviousFirst = options.bClearPreviousFirst === true;
        const bTriggerSync        = options.bTriggerSync !== false;
        const force               = options.force === true;
        const skipAnalysis        = options.skipAnalysis === true;
        const regenerateTopics    = Array.isArray(options.regenerateTopics) ? options.regenerateTopics : [];
        // Allow callers to override the autoGenerateCuratedStudy
        // payload flag. The auto dispatcher passes nothing → we fall
        // through to the deck's persisted toggle (existing behaviour).
        // Manual / Continue / all-easy paths pass `true` so the agent
        // spawns curated children even when the deck's auto-toggle is
        // disabled (that toggle only governs unattended runs).
        const autoGenerateCuratedStudyOverride = typeof options.autoGenerateCuratedStudy === "boolean"
            ? options.autoGenerateCuratedStudy
            : null;
        const onStatusChange      = typeof options.onStatusChange === "function" ? options.onStatusChange : null;

        if (bClearPreviousFirst)
        {
            await AnalysisTaskRunner.clearPreviousAnalysis(deck);
        }

        const queueResult = await AnalysisTaskRunner.#postQueueRequest(deck, { force, skipAnalysis, regenerateTopics, autoGenerateCuratedStudyOverride });
        const taskId             = queueResult.taskId;
        const bAlreadyRunning    = queueResult.bAlreadyRunning === true;
        // The server returns a `reason` discriminator on the 409
        // path so we can distinguish a benign auto-join (an unrelated
        // analysis that happened to be running) from a force-regen
        // that was actively rejected. Surfacing it through the result
        // lets the caller decide whether to wait, alert, or retry.
        const reason            = typeof queueResult.reason === "string" ? queueResult.reason : null;

        if (onStatusChange)
        {
            onStatusChange({ phase: bAlreadyRunning ? "joined-existing-run" : "queued", taskId: taskId, bAlreadyRunning: bAlreadyRunning, reason: reason });
        }

        const finalTaskTree = await AnalysisTaskRunner.#pollUntilTerminal(taskId, onStatusChange);
        const finalStatus   = (finalTaskTree && typeof finalTaskTree.status === "number") ? finalTaskTree.status : taskStatus.UNKNOWN;

        if (onStatusChange)
        {
            onStatusChange({ phase: "task-terminal", taskTree: finalTaskTree, status: finalStatus });
        }

        if (bTriggerSync && finalStatus === taskStatus.COMPLETED)
        {
            await AnalysisTaskRunner.triggerSync();
            if (onStatusChange)
            {
                onStatusChange({ phase: "sync-complete" });
            }
        }

        return { taskTree: finalTaskTree, status: finalStatus, bAlreadyRunning: bAlreadyRunning, reason: reason };
    }

    /**
     * Wipes the deck's analysis-result fields and deletes every
     * curated StudyMaterial belonging to the deck (or any
     * descendant). Mirrors the "Clear Analysis Data" button on
     * DeckEditorPage so callers can re-run analysis cleanly.
     */
    static async clearPreviousAnalysis(deck)
    {
        // Must pass bIncludeCurated=true — the whole point of this
        // method is to delete curated materials, which the default
        // (bIncludeCurated=false) would silently filter out.
        const studyMaterials = deck.getStudyMaterials(true, true);
        const pendingDeletions = [];
        for (const studyMaterial of studyMaterials)
        {
            if (studyMaterial.isCurated())
            {
                pendingDeletions.push(studyMaterial.delete());
            }
        }
        if (pendingDeletions.length > 0)
        {
            await Promise.all(pendingDeletions);
        }

        deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_ANALYZED_AT, null);
        deck.setAdditionalDataField(AutoAnalysisDeckFields.LAST_ANALYSIS_TOPICS, null);
        await deck.save(false);
    }

    /**
     * Triggers a single sync cycle. SyncOrchestrator's `sync` is
     * async but dispatches its progress + completion via events
     * rather than via the returned promise, so we wait on the
     * COMPLETED event and resolve when it fires. A FAILED event
     * resolves with rejection.
     */
    static async triggerSync()
    {
        return new Promise((resolve, reject) =>
        {
            const onCompleted = () =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                resolve();
            };
            const onFailed = (failedEvent) =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                const failureReason = failedEvent?.detail?.error || new Error("Sync failed.");
                reject(failureReason);
            };
            window.addEventListener(SyncEvents.COMPLETED, onCompleted);
            window.addEventListener(SyncEvents.FAILED, onFailed);

            SyncOrchestrator.sync({ bForce: true }).catch((triggerError) =>
            {
                window.removeEventListener(SyncEvents.COMPLETED, onCompleted);
                window.removeEventListener(SyncEvents.FAILED, onFailed);
                reject(triggerError);
            });
        });
    }

    static async #postQueueRequest(deck, curatedFlags = {})
    {
        const additionalData = deck.getAdditionalData() || {};
        // Use the caller's override when provided; fall back to the
        // deck's persisted toggle for unattended (dispatcher) calls.
        const autoGenerateCuratedStudy = (curatedFlags.autoGenerateCuratedStudyOverride === null || curatedFlags.autoGenerateCuratedStudyOverride === undefined)
            ? additionalData[AutoAnalysisDeckFields.AUTO_GENERATE_CURATED_STUDY_ENABLED] === true
            : curatedFlags.autoGenerateCuratedStudyOverride === true;

        const requestBody = JSON.stringify
        ({
            deckId: deck.getId(),
            autoGenerateCuratedStudy: autoGenerateCuratedStudy,
            force: curatedFlags.force === true,
            skipAnalysis: curatedFlags.skipAnalysis === true,
            regenerateTopics: Array.isArray(curatedFlags.regenerateTopics) ? curatedFlags.regenerateTopics : [],
        });

        const response = await fetch(AnalysisTaskRunner.QUEUE_ENDPOINT,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: requestBody,
        });

        // 409 is the server's "force regen blocked by an already-running
        // task" signal — the response body still carries the existing
        // task's id so callers can join it transparently if they choose.
        if (!response.ok && response.status !== 409)
        {
            const responseText = await response.text().catch(() => "");
            throw new Error(`${AnalysisTaskRunner.QUEUE_ENDPOINT} returned ${response.status}: ${responseText}`);
        }

        const responseBody = await response.json();
        if (!responseBody || typeof responseBody.taskId !== "string")
        {
            throw new Error(`${AnalysisTaskRunner.QUEUE_ENDPOINT} returned an unexpected response shape.`);
        }
        return responseBody;
    }

    /**
     * Polls /Generate/Progress every POLL_INTERVAL_MILLISECONDS and
     * resolves with the final task tree once the task reaches a
     * terminal status. A MAX_POLL_DURATION_MILLISECONDS safety cap
     * stops the polling from running forever if something goes wrong
     * server-side and the task never lands at COMPLETED/FAILED.
     */
    /**
     * Recursive tree-status check. Mirrors `isSubtreeTerminal` on the
     * Dock side: a tree is terminal only when its root AND every
     * descendant is in COMPLETED or FAILED. Used by the polling loop
     * so the resolve fires after the entire ANALYZE_DECK_PERFORMANCE
     * → GENERATE_CURATED_STUDY_MATERIAL fan-out lands, not just the
     * orchestrator parent.
     */
    static #isTreeTerminal(node)
    {
        if (!node)
        {
            return true;
        }
        const nodeStatus = typeof node.status === "number" ? node.status : taskStatus.UNKNOWN;
        if (nodeStatus !== taskStatus.COMPLETED && nodeStatus !== taskStatus.FAILED)
        {
            return false;
        }
        const children = Array.isArray(node.children) ? node.children : [];
        for (const childNode of children)
        {
            if (!AnalysisTaskRunner.#isTreeTerminal(childNode))
            {
                return false;
            }
        }
        return true;
    }

    static async #pollUntilTerminal(taskId, onStatusChange)
    {
        const startTimestampMilliseconds = Date.now();

        return new Promise((resolve, reject) =>
        {
            let intervalHandle = null;

            const cleanupAndResolve = (terminalTaskTree) =>
            {
                if (intervalHandle !== null)
                {
                    clearInterval(intervalHandle);
                    intervalHandle = null;
                }
                resolve(terminalTaskTree);
            };

            const cleanupAndReject = (pollError) =>
            {
                if (intervalHandle !== null)
                {
                    clearInterval(intervalHandle);
                    intervalHandle = null;
                }
                reject(pollError);
            };

            const pollOnce = async () =>
            {
                try
                {
                    if (Date.now() - startTimestampMilliseconds > AnalysisTaskRunner.MAX_POLL_DURATION_MILLISECONDS)
                    {
                        cleanupAndReject(new Error("Analysis task timed out — server never reported COMPLETED."));
                        return;
                    }

                    const progressResponse = await fetch(`${AnalysisTaskRunner.PROGRESS_ENDPOINT}?taskid=${encodeURIComponent(taskId)}`,
                    {
                        method: "GET",
                        credentials: "same-origin",
                    });
                    if (!progressResponse.ok)
                    {
                        const responseText = await progressResponse.text().catch(() => "");
                        cleanupAndReject(new Error(`${AnalysisTaskRunner.PROGRESS_ENDPOINT} returned ${progressResponse.status}: ${responseText}`));
                        return;
                    }
                    const taskTree = await progressResponse.json();

                    if (onStatusChange)
                    {
                        onStatusChange({ phase: "progress", taskTree: taskTree });
                    }

                    // Walk the whole task tree, not just the root.
                    // ANALYZE_DECK_PERFORMANCE spawns
                    // GENERATE_CURATED_STUDY_MATERIAL children that own
                    // the actual material + flashcard writes. The
                    // parent's `status` flips to COMPLETED the moment
                    // run() returns (i.e. once children are queued),
                    // long before children themselves finish. Resolving
                    // on parent-only would trigger a sync against a
                    // database that doesn't yet hold the new materials,
                    // which the Continue-branch session would then
                    // interpret as "every topic passed, all easy" and
                    // incorrectly congratulate the user. So wait for
                    // every node — including children — to land
                    // terminal before resolving.
                    if (AnalysisTaskRunner.#isTreeTerminal(taskTree))
                    {
                        cleanupAndResolve(taskTree);
                    }
                }
                catch (pollError)
                {
                    cleanupAndReject(pollError);
                }
            };

            // Fire one immediate poll so the caller sees `progress`
            // before the first 2-second interval, then settle into
            // the steady polling cadence.
            pollOnce();
            intervalHandle = setInterval(pollOnce, AnalysisTaskRunner.POLL_INTERVAL_MILLISECONDS);
        });
    }
}

export default AnalysisTaskRunner;
