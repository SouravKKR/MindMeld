import AutoAnalysisDeckFields from "./AutoAnalysisDeckFields.js";
import TaskProgressTracker from "../Task/TaskProgressTracker.js";
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
    static QUEUE_ENDPOINT = "/Analysis/QueueDeckAnalysis";

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

        // Delegate the polling + sync-trigger to TaskProgressTracker so
        // this runner shares one implementation with the mock-test
        // evaluation wait flow. When bTriggerSync is false (legacy
        // dispatcher callers), poll only without firing the post-task
        // sync — the dispatcher handles its own sync batching.
        const trackResult = bTriggerSync
            ? await TaskProgressTracker.trackAndSync(taskId, onStatusChange)
            : { taskTree: await TaskProgressTracker.pollUntilTerminal(taskId, onStatusChange), status: taskStatus.UNKNOWN };

        const finalTaskTree = trackResult.taskTree;
        const finalStatus = (finalTaskTree && typeof finalTaskTree.status === "number") ? finalTaskTree.status : taskStatus.UNKNOWN;

        if (!bTriggerSync && onStatusChange)
        {
            onStatusChange({ phase: "task-terminal", taskTree: finalTaskTree, status: finalStatus });
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
     * Triggers a single sync cycle. Delegates to TaskProgressTracker
     * which now owns the canonical implementation; kept here as a
     * thin alias for backwards compatibility with any caller that
     * still imports AnalysisTaskRunner.triggerSync directly.
     */
    static async triggerSync()
    {
        return await TaskProgressTracker.triggerSync();
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

    // The legacy `#pollUntilTerminal` + `#isTreeTerminal` lived here
    // before this file was refactored to delegate to TaskProgressTracker.
    // Both are now owned by `Main/Globals/Classes/Task/TaskProgressTracker.js`;
    // calling `TaskProgressTracker.trackAndSync(taskId, onStatusChange)`
    // reproduces the exact same polling + tree-terminal + sync-trigger
    // behaviour and dispatches the same phase events ("progress",
    // "task-terminal", "sync-complete") this runner used to emit itself.
}

export default AnalysisTaskRunner;
