const { taskStatus } = require("../../Enumerations/TaskStatus");
const { taskTypes } = require("../../Enumerations/TaskTypes");

/**
 * GenerationProgressSummarizer
 *
 * Rolls a generation task tree up into the three numbers a progress bar needs:
 * overall completion, overall status, and whether the run has finished.
 *
 * This logic used to live only in the browser, inside
 * Main/Pages/Progress/Components/GenerationProgressComponent.js, because the
 * client was always handed the whole tree. It no longer is — a normal user now
 * receives a summary and never sees the internal task graph — so the roll-up has
 * to happen where the tree still exists. The component keeps its own copy purely
 * as a fallback for the tutorial's canned demo snapshots, which never touch a
 * server; for every real run this class is the authority, so an admin watching
 * the tree and a user watching the bar can never read different percentages.
 *
 * Any change to the phase weights or the accumulating-parent rule here must be
 * mirrored in that component, and vice versa.
 */
class GenerationProgressSummarizer
{
    // Canonical pipeline phases → cumulative bands of the overall bar. The bar
    // advances as each phase's effective completion rises; a finished phase keeps
    // contributing its full band while the next phase is still at 0 (fixing the
    // boundary dip to ~0). Generate is the bulk of the work, so it owns the
    // widest band. Weights sum to 1.0.
    static #OVERALL_PHASES =
    [
        { types: [taskTypes.PROCESS_SYLLABUS], weight: 0.15 },
        { types: [taskTypes.MAP_TOPICS_WITH_CONTENT], weight: 0.30 },
        { types: [taskTypes.GENERATE_FLASHCARDS, taskTypes.GENERATE_STUDY_MATERIAL, taskTypes.GENERATE_MOCK_TESTS], weight: 0.45 },
        { types: [taskTypes.GENERATION_FINALIZATION, taskTypes.PREPARE_IMAGES, taskTypes.ENHANCE_IMAGES, taskTypes.BEAUTIFY_DECK_SHORT_NAMES], weight: 0.10 },
    ];

    /**
     * @param {object|null} treeNode a root progress tree, post-appendPostPipelineProgress
     * @returns {{overallCompletion: number, overallStatus: number, bTerminal: boolean, failureMessage: (string|null)}}
     */
    static summarize(treeNode)
    {
        if (!treeNode)
        {
            return { overallCompletion: 0, overallStatus: taskStatus.NOT_STARTED, bTerminal: false, failureMessage: null };
        }

        const overallStatus = GenerationProgressSummarizer.#computeOverallStatus(treeNode);
        const overallCompletion = GenerationProgressSummarizer.#computeOverallCompletion(treeNode, overallStatus);

        return {
            overallCompletion: overallCompletion,
            overallStatus: overallStatus,
            bTerminal: overallStatus === taskStatus.COMPLETED || overallStatus === taskStatus.FAILED,
            failureMessage: GenerationProgressSummarizer.#findFirstFailureMessage(treeNode)
        };
    }

    /**
     * The reason the run failed, taken from the first failed node that recorded
     * one. Without this a user who cannot see the tree would be told only that
     * the run failed, never why — the Agent writes a concise, user-readable
     * reason onto the failing task's payload precisely so it can be shown.
     *
     * @returns {string|null} null when nothing failed, or nothing recorded a reason
     */
    static #findFirstFailureMessage(treeNode)
    {
        for (const taskNode of GenerationProgressSummarizer.#flattenTree(treeNode))
        {
            if (GenerationProgressSummarizer.#computeEffectiveStatus(taskNode) !== taskStatus.FAILED)
            {
                continue;
            }

            const message = String(taskNode.error ?? "").trim();
            if (message.length > 0)
            {
                return message;
            }
        }

        return null;
    }

    /**
     * The subset of children that are workers contributing to this node's own
     * work — tasks explicitly spawned with parent_task_id set to this node.
     *
     * Children without a matching parentTaskId are sequential-phase successors
     * wired through nextTaskIds. They run AFTER this node finishes and so do not
     * contribute to its completion; folding them in would report a finished
     * stage as partially done for as long as its successors keep running.
     */
    static #getWorkerChildren(taskNode)
    {
        if (!Array.isArray(taskNode.children))
        {
            return [];
        }
        return taskNode.children.filter(childNode => childNode.parentTaskId === taskNode.id);
    }

    /**
     * Effective completion for a single node.
     *
     * With worker children → the average of those workers' effective
     * completions. A parent's own stored completion jumps to 1.0 the instant its
     * workflow exits, which races ahead of the workers it spawned, so its own
     * value is not usable.
     *
     * Otherwise → its own stored completion.
     */
    static #computeEffectiveCompletion(taskNode)
    {
        const workerChildren = GenerationProgressSummarizer.#getWorkerChildren(taskNode);
        if (workerChildren.length > 0)
        {
            const childCompletions = workerChildren.map(childNode => GenerationProgressSummarizer.#computeEffectiveCompletion(childNode));
            return childCompletions.reduce((runningTotal, completion) => runningTotal + completion, 0) / childCompletions.length;
        }

        return taskNode.completion ?? 0;
    }

    /**
     * Effective status for a single node: any worker FAILED → FAILED, every
     * worker terminal → COMPLETED, otherwise IN_PROGRESS. A node without
     * workers reports its own stored status.
     */
    static #computeEffectiveStatus(taskNode)
    {
        const workerChildren = GenerationProgressSummarizer.#getWorkerChildren(taskNode);
        if (workerChildren.length > 0)
        {
            const childStatuses = workerChildren.map(childNode => GenerationProgressSummarizer.#computeEffectiveStatus(childNode));

            if (childStatuses.some(status => status === taskStatus.FAILED))
            {
                return taskStatus.FAILED;
            }

            if (childStatuses.every(status => status === taskStatus.COMPLETED || status === taskStatus.FAILED))
            {
                return taskStatus.COMPLETED;
            }

            return taskStatus.IN_PROGRESS;
        }

        return taskNode.status;
    }

    static #flattenTree(taskNode)
    {
        return [taskNode, ...(taskNode.children || []).flatMap(childNode => GenerationProgressSummarizer.#flattenTree(childNode))];
    }

    /**
     * Overall completion (0-1) as a phase-weighted sum.
     *
     * Averaging recursively across all children instead would discard a finished
     * parent's own completion in favour of its children's average, collapsing the
     * bar to roughly 0 at every stage boundary. Mapping the canonical phases to
     * cumulative bands and summing each phase's effective completion is monotonic
     * in real progress and is recomputed from the tree on every poll, so
     * reopening a run mid-flight shows the right value immediately. A phase whose
     * node is not in the tree yet contributes 0.
     *
     * @param {object} taskTree
     * @param {number} overallStatus already computed by the caller, so the tree
     *        is not walked twice for it
     */
    static #computeOverallCompletion(taskTree, overallStatus)
    {
        // A finished run reads 100% even though the transient finalization node
        // is removed from the tree once moveToDatabase clears its marker, which
        // would otherwise drop the phased sum back to 0.90 at the very end.
        if (overallStatus === taskStatus.COMPLETED)
        {
            return 1.0;
        }

        const allNodes = GenerationProgressSummarizer.#flattenTree(taskTree);

        let overallCompletion = 0;
        for (const phase of GenerationProgressSummarizer.#OVERALL_PHASES)
        {
            const phaseNodes = allNodes.filter(taskNode => phase.types.includes(taskNode.type));
            if (phaseNodes.length === 0)
            {
                continue;
            }
            const phaseCompletion = phaseNodes
                .map(taskNode => GenerationProgressSummarizer.#computeEffectiveCompletion(taskNode))
                .reduce((runningTotal, completion) => runningTotal + completion, 0) / phaseNodes.length;
            overallCompletion += phase.weight * phaseCompletion;
        }
        return overallCompletion;
    }

    /**
     * Overall status from every node's effective status: any FAILED → FAILED,
     * all terminal → COMPLETED, any IN_PROGRESS → IN_PROGRESS, else NOT_STARTED.
     */
    static #computeOverallStatus(taskTree)
    {
        const allNodes = GenerationProgressSummarizer.#flattenTree(taskTree);
        const statuses = allNodes.map(taskNode => GenerationProgressSummarizer.#computeEffectiveStatus(taskNode));

        if (statuses.some(status => status === taskStatus.FAILED))
        {
            return taskStatus.FAILED;
        }

        if (statuses.every(status => status === taskStatus.COMPLETED || status === taskStatus.FAILED))
        {
            return taskStatus.COMPLETED;
        }

        if (statuses.some(status => status === taskStatus.IN_PROGRESS))
        {
            return taskStatus.IN_PROGRESS;
        }

        return taskStatus.NOT_STARTED;
    }
}

module.exports = GenerationProgressSummarizer;
