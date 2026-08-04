import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { taskTypeDisplayName } from "../../../Globals/UtilityFunctions/TaskTypeDisplayName.js";

/**
 * GenerationProgressComponent
 *
 * A reusable web component that renders a generation's progress.
 *
 * Usage:
 *   const component = document.createElement("generation-progress-component");
 *   component.update(taskTree);
 *
 * Two payload shapes arrive here, and the difference is who is watching:
 *
 *   1. Summary (every non-administrator). No `children`, `summaryOnly: true`,
 *      and the server's own roll-up in `overallCompletion` / `overallStatus` /
 *      `isTerminal` / `failureMessage`. The per-task tree is internal telemetry
 *      that only invites a user to sit and watch a run lasting hours, so instead
 *      of rows they get the overall bar and a note telling them they will be
 *      notified and are free to go and study.
 *
 *   2. Full tree (administrators). Everything above PLUS the recursive
 *      `children`, so a stuck run can still be diagnosed node by node.
 *
 * taskTree shape (recursive):
 *   {
 *     id:           string,
 *     type:         number,   // TaskTypes enum value
 *     status:       number,   // TaskStatus enum value
 *     completion:   number,   // 0.0 – 1.0
 *     parentTaskId: string|null,
 *     children:     taskTree[]   // administrators only
 *   }
 *
 * The overall figures are computed by the server
 * (Dock/Globals/Classes/Task/GenerationProgressSummarizer) rather than here, so
 * there is exactly one implementation of the roll-up and an administrator
 * reading the tree can never see a different percentage from a user reading the
 * bar. The local roll-up below is a fallback for a payload that carries no
 * summary — in practice only the tutorial's canned demo snapshots, which never
 * reach a server.
 *
 * Accumulating parent pattern:
 *   Some tasks (e.g. GenerateFlashcards) create worker sub-tasks that call
 *   increment_completion(parentId) to report progress back. These workers store
 *   parentTaskId = the parent's id. When a node has children pointing to it via
 *   parentTaskId, it is an accumulating parent — its displayed completion and
 *   status are derived from its children rather than its own stored values (which
 *   are set to 1.0/COMPLETED the moment it exits, before workers are done).
 */
class GenerationProgressComponent extends HTMLElement
{
    #taskTree = null;
    #overallCompletionHighWaterMark = 0;

    // Canonical pipeline phases → cumulative bands of the overall bar. The bar
    // advances as each phase's effective completion rises; a finished phase keeps
    // contributing its full band while the next phase is still at 0 (fixing the
    // boundary dip to ~0). Generate is the bulk of the work, so it owns the
    // widest band. Weights sum to 1.0.
    static #OVERALL_PHASES =
    [
        { types: [taskTypes.PROCESS_SYLLABUS],            weight: 0.15 },
        { types: [taskTypes.MAP_TOPICS_WITH_CONTENT],     weight: 0.30 },
        { types: [taskTypes.GENERATE_FLASHCARDS, taskTypes.GENERATE_STUDY_MATERIAL, taskTypes.GENERATE_MOCK_TESTS], weight: 0.45 },
        { types: [taskTypes.GENERATION_FINALIZATION, taskTypes.PREPARE_IMAGES, taskTypes.ENHANCE_IMAGES, taskTypes.BEAUTIFY_DECK_SHORT_NAMES], weight: 0.10 },
    ];

    // Task types that report no sub-progress of their own. GENERATION_FINALIZATION
    // is synthetic — the server mints it to represent the marker-only
    // moveToDatabase tail, which has no steps to count — so its completion is a
    // fixed placeholder, not a measurement.
    //
    // Such a row is rendered as indeterminate: a pulsing bar and no percentage.
    // It used to be animated from a fixed server value toward a 0.95 ceiling on a
    // 15-second half-life, which made "Finalizing…" the fastest-moving row on the
    // page while every real task sat at 0 — the bar advanced on a clock, so it
    // looked healthiest exactly when the pipeline had died and fallen straight
    // through to its tail. A row that cannot measure itself must say so rather
    // than invent a number.
    static #INDETERMINATE_TASK_TYPES = [taskTypes.GENERATION_FINALIZATION];

    // Shown in place of the task tree to everyone who does not get the tree. The
    // point is to release the user from the page: a generation can take hours,
    // and without being told so people sit and watch a bar.
    static SUMMARY_PRIMARY_MESSAGE = "You will be notified upon completion, it may take a few minutes to a few hours.";
    static SUMMARY_SECONDARY_MESSAGE = "You can either wait or continue studying and check in later.";

    // ─────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────

    /**
     * Updates the component with a fresh task tree and re-renders.
     * @param {object} taskTree
     */
    update(taskTree)
    {
        this.#taskTree = taskTree;
        this.#render();
    }

    /**
     * True when a node has no real sub-progress to report, so its percentage
     * would be a placeholder rather than a measurement.
     * @param {object} taskNode
     * @returns {boolean}
     */
    #isIndeterminateNode(taskNode)
    {
        return GenerationProgressComponent.#INDETERMINATE_TASK_TYPES.includes(taskNode.type);
    }

    /**
     * True when this payload carries no per-task tree, so the summary view is
     * what should be rendered.
     * @returns {boolean}
     */
    #isSummaryOnly()
    {
        return this.#taskTree?.summaryOnly === true || !Array.isArray(this.#taskTree?.children);
    }

    /**
     * Returns the overall pipeline completion (0–1).
     *
     * Prefers the server's figure, which is the authority for every real run.
     * The local roll-up only runs for a payload without one.
     * @returns {number}
     */
    getOverallCompletion()
    {
        if (!this.#taskTree) return 0;

        if (typeof this.#taskTree.overallCompletion === "number")
        {
            return Math.min(1, Math.max(0, this.#taskTree.overallCompletion));
        }

        return this.#computeOverallCompletion(this.#taskTree);
    }

    /**
     * Returns true when the pipeline has reached a terminal state.
     * @returns {boolean}
     */
    isTerminal()
    {
        if (!this.#taskTree) return false;

        if (typeof this.#taskTree.isTerminal === "boolean")
        {
            return this.#taskTree.isTerminal;
        }

        const overallStatus = this.getOverallStatus();
        return overallStatus === taskStatus.COMPLETED || overallStatus === taskStatus.FAILED;
    }

    /**
     * Returns the canonical overall pipeline status (TaskStatus enum value).
     * Exposed so background consumers (e.g. GenerationNotifier) can distinguish
     * a COMPLETED pipeline from a FAILED one without re-implementing the roll-up.
     * Returns NOT_STARTED when there is no task tree yet.
     * @returns {number}
     */
    getOverallStatus()
    {
        if (!this.#taskTree) return taskStatus.NOT_STARTED;

        if (Number.isInteger(this.#taskTree.overallStatus))
        {
            return this.#taskTree.overallStatus;
        }

        return this.#computeOverallStatus(this.#taskTree);
    }

    /**
     * Returns the error message of the first failed node in the tree, or null
     * when nothing failed (or the failed node carried no message). The Agent
     * records a concise, user-readable reason on the failing task's
     * payload.error, which GetProgress surfaces as node.error — this exposes it
     * so the progress page can tell the user WHY a run failed instead of just
     * "failed".
     * @returns {string|null}
     */
    getFirstFailureMessage()
    {
        if (!this.#taskTree)
        {
            return null;
        }

        // Without the tree there is nothing to scan, so the server sends the
        // reason alongside the roll-up. Skipping this would leave a user who
        // cannot see the tree told only THAT the run failed, never why.
        if (typeof this.#taskTree.failureMessage === "string" && this.#taskTree.failureMessage.trim().length > 0)
        {
            return this.#taskTree.failureMessage.trim();
        }

        for (const taskNode of this.#flattenTree(this.#taskTree))
        {
            if (this.#computeEffectiveStatus(taskNode) === taskStatus.FAILED)
            {
                const message = (taskNode.error || "").trim();
                if (message.length > 0)
                {
                    return message;
                }
            }
        }

        return null;
    }

    // ─────────────────────────────────────────────
    //  Accumulation Detection
    // ─────────────────────────────────────────────

    /**
     * Returns the subset of children that are workers contributing to this
     * node's own work — i.e. tasks explicitly spawned with
     * `parent_task_id=current_task.get_id()` (see
     * GenerateFlashcards.py spawning FlashcardGenerationWorker, etc.).
     *
     * Children that lack a matching parentTaskId are sequential-phase
     * successors wired via `nextTaskIds`. They run AFTER this node finishes
     * and therefore do NOT contribute to its own completion — folding them
     * in produces the misleading "20% MapTopics" the user reported when
     * MapTopics has already finished but Flashcards / StudyMat / MockTests
     * are still running underneath it.
     */
    #getWorkerChildren(taskNode)
    {
        if (!Array.isArray(taskNode.children))
        {
            return [];
        }
        return taskNode.children.filter(childNode => childNode.parentTaskId === taskNode.id);
    }

    /**
     * Returns true when a node has worker children whose progress must be
     * folded into the parent's effective completion. Sequential-phase
     * children do not qualify.
     *
     * @param {object} taskNode
     * @returns {boolean}
     */
    #isAccumulatingParent(taskNode)
    {
        return this.#getWorkerChildren(taskNode).length > 0;
    }

    // ─────────────────────────────────────────────
    //  Effective State (per node)
    // ─────────────────────────────────────────────

    /**
     * Computes the effective completion for a single node.
     *
     * Has worker children → average over those workers' effective completions.
     *   The parent's own stored completion bumps to 1.0 the instant the
     *   workflow's `finally` block runs, which races ahead of the workers
     *   it spawned. Averaging the workers gives the true picture.
     *
     * Otherwise → own stored completion value. Crucially, a node whose
     * only children are sequential phases (e.g. MapTopics → [Flashcards,
     * StudyMat, MockTests]) is NOT an accumulator: those siblings run
     * after it finishes, so its own stored 1.0 is the right answer.
     *
     * @param {object} taskNode
     * @returns {number}
     */
    #computeEffectiveCompletion(taskNode)
    {
        const workerChildren = this.#getWorkerChildren(taskNode);
        if (workerChildren.length > 0)
        {
            const childCompletions = workerChildren.map(childNode => this.#computeEffectiveCompletion(childNode));
            return childCompletions.reduce((sum, completion) => sum + completion, 0) / childCompletions.length;
        }

        return taskNode.completion ?? 0;
    }

    /**
     * Computes the effective status for a single node.
     *
     * Has worker children → derived from those workers' effective statuses:
     *   any FAILED → FAILED
     *   all COMPLETED/FAILED → COMPLETED
     *   otherwise → IN_PROGRESS
     *
     * Otherwise → own stored status value. (Sequential-phase children do
     * NOT roll up into this node's status — once it's COMPLETED it stays
     * COMPLETED even while its successors still run.)
     *
     * @param {object} taskNode
     * @returns {number}
     */
    #computeEffectiveStatus(taskNode)
    {
        const workerChildren = this.#getWorkerChildren(taskNode);
        if (workerChildren.length > 0)
        {
            const childStatuses = workerChildren.map(childNode => this.#computeEffectiveStatus(childNode));

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

    // ─────────────────────────────────────────────
    //  Overall Pipeline State
    // ─────────────────────────────────────────────

    /**
     * Flattens the entire task tree into a single array of all nodes.
     * @param {object} taskNode
     * @returns {object[]}
     */
    #flattenTree(taskNode)
    {
        return [taskNode, ...(taskNode.children || []).flatMap(childNode => this.#flattenTree(childNode))];
    }

    /**
     * Computes the overall pipeline completion (0–1) as a phase-weighted sum.
     *
     * The old approach (recursive average across all children) discarded a
     * finished parent's own completion in favour of its children's average, so
     * the bar collapsed to ~0 at every stage boundary (e.g. Process Syllabus
     * done but Map Topics still 0%) — invisible on the live page only because a
     * high-water-mark masked it, but exposed as "0%" on a fresh mount via
     * Activity. Instead we map the canonical pipeline phases to cumulative bands
     * and sum each phase's EFFECTIVE completion (worker-fold-aware) scaled by its
     * band width. This is monotonic in real progress, starts at 0, and is
     * recomputed from the tree on every poll — so reopening from Activity shows
     * the correct value immediately. Generate owns the widest band (it is the
     * bulk of the work). A phase whose node isn't in the tree yet contributes 0.
     *
     * @param {object} taskTree
     * @returns {number}
     */
    #computeOverallCompletion(taskTree)
    {
        if (!taskTree)
        {
            return 0;
        }

        // A finished run reads 100% even though the transient finalization node
        // is removed from the tree once moveToDatabase clears its marker (which
        // would otherwise drop the phased sum back to 0.90 at the very end).
        if (this.#computeOverallStatus(taskTree) === taskStatus.COMPLETED)
        {
            return 1.0;
        }

        const allNodes = this.#flattenTree(taskTree);

        let overallCompletion = 0;
        for (const phase of GenerationProgressComponent.#OVERALL_PHASES)
        {
            const phaseNodes = allNodes.filter(taskNode => phase.types.includes(taskNode.type));
            if (phaseNodes.length === 0)
            {
                continue;
            }
            const phaseCompletion = phaseNodes
                .map(taskNode => this.#computeEffectiveCompletion(taskNode))
                .reduce((sum, completion) => sum + completion, 0) / phaseNodes.length;
            overallCompletion += phase.weight * phaseCompletion;
        }
        return overallCompletion;
    }

    /**
     * Computes the overall pipeline status from every node's effective status.
     *   any FAILED → FAILED
     *   all COMPLETED/FAILED → COMPLETED
     *   any IN_PROGRESS → IN_PROGRESS
     *   otherwise → NOT_STARTED
     * @param {object} taskTree
     * @returns {number}
     */
    #computeOverallStatus(taskTree)
    {
        const allNodes = this.#flattenTree(taskTree);
        const statuses = allNodes.map(taskNode => this.#computeEffectiveStatus(taskNode));

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

    // ─────────────────────────────────────────────
    //  Display Helpers
    // ─────────────────────────────────────────────

    /**
     * Returns a human-readable label for a task type value.
     * @param {number} typeValue
     * @returns {string}
     */
    #getTaskTypeLabel(typeValue)
    {
        return taskTypeDisplayName(typeValue);
    }

    /**
     * Returns display metadata (label, color, pulse) for a task status value.
     * @param {number} statusValue
     * @returns {{ label: string, color: string, pulse: boolean }}
     */
    #getStatusMetadata(statusValue)
    {
        if (statusValue === taskStatus.COMPLETED)
        {
            return { label: "Done",        color: "var(--status-success)",     pulse: false };
        }

        if (statusValue === taskStatus.IN_PROGRESS)
        {
            return { label: "In Progress", color: "var(--status-in-progress)",  pulse: true  };
        }

        if (statusValue === taskStatus.FAILED)
        {
            return { label: "Failed",      color: "var(--status-failed)",       pulse: false };
        }

        if (statusValue === taskStatus.NOT_STARTED)
        {
            return { label: "Queued",      color: "var(--quaternary-background-color)", pulse: false };
        }

        return { label: "Unknown", color: "var(--quaternary-background-color)", pulse: false };
    }

    /**
     * Display metadata for the OVERALL bar. A user-paused or out-of-credits run is
     * recoverable, not failed — but the pipeline stamps the root task FAILED to
     * stop launching new stages, so #computeOverallStatus would report FAILED and
     * the bar would read "Failed" right next to the "Generation paused — resume
     * it" banner. The tree carries a `paused` / `outOfCredits` flag for exactly
     * this; honour it so the overall status reads "Paused" instead.
     * @returns {{ label: string, color: string }}
     */
    #getOverallStatusDisplay()
    {
        if (this.#taskTree && (this.#taskTree.paused === true || this.#taskTree.outOfCredits === true))
        {
            return { label: "Paused", color: "var(--status-warning, #F0AA32)" };
        }
        return this.#getStatusMetadata(this.getOverallStatus());
    }

    /**
     * Recursively builds the HTML string for a task node and all its descendants.
     * Uses effective completion and status so accumulating parents display correctly.
     * @param {object} taskNode
     * @param {number} depth
     * @returns {string}
     */
    #buildTaskNodeHtml(taskNode, depth = 0)
    {
        const effectiveCompletion  = this.#computeEffectiveCompletion(taskNode);
        const effectiveStatus      = this.#computeEffectiveStatus(taskNode);

        const label                = this.#getTaskTypeLabel(taskNode.type);
        const completionPct        = Math.round(effectiveCompletion * 100);
        const statusMetadata       = this.#getStatusMetadata(effectiveStatus);
        const indentPixels         = depth * 6;
        const progressBarColor     = effectiveStatus === taskStatus.FAILED
            ? "var(--status-failed)"
            : "linear-gradient(90deg, var(--gradient-start-color), var(--gradient-end-color))";

        // An indeterminate node still shows a filled bar once it is terminal —
        // "done" and "failed" are real, measured outcomes. It is only while the
        // node is running that there is nothing truthful to put a number on.
        const bIsStillRunning      = effectiveStatus !== taskStatus.COMPLETED && effectiveStatus !== taskStatus.FAILED;
        const bIsIndeterminate     = this.#isIndeterminateNode(taskNode) && bIsStillRunning;
        const displayedPercentage  = bIsIndeterminate ? "" : `${completionPct}%`;
        const progressBarWidthPct  = bIsIndeterminate ? 100 : completionPct;

        const childrenHtml = (taskNode.children || [])
            .map(childNode => this.#buildTaskNodeHtml(childNode, depth + 1))
            .join("");

        return `
            <div class="task-node ${statusMetadata.pulse ? "task-node-pulsing" : ""}" style="margin-left: ${indentPixels}px;" data-task-id="${taskNode.id}">
                <div class="task-node-header">
                    <div class="task-node-status-dot" style="background: ${statusMetadata.color};"></div>
                    <span class="task-node-label">${label}</span>
                    <span class="task-node-status-label" style="color: ${statusMetadata.color};">${statusMetadata.label}</span>
                    <span class="task-node-completion-percentage">${displayedPercentage}</span>
                </div>
                <div class="task-node-progress-track">
                    <div class="task-node-progress-fill ${bIsIndeterminate ? "task-node-progress-fill-indeterminate" : ""}" style="width: ${progressBarWidthPct}%; background: ${progressBarColor};"></div>
                </div>
                ${childrenHtml ? `<div class="task-node-children">${childrenHtml}</div>` : ""}
            </div>
        `;
    }

    // ─────────────────────────────────────────────
    //  Rendering
    // ─────────────────────────────────────────────

    #render()
    {
        if (!this.isConnected) return;

        if (!this.#taskTree)
        {
            this.querySelector(".task-tree-container").innerHTML =
                `<div class="task-tree-empty-message">Waiting for task data...</div>`;
            return;
        }

        const overallCompletion      = this.getOverallCompletion();

        // Advance the high water mark but never retreat it.
        // Transitions between pipeline stages cause brief computed dips
        // (e.g. when tasks complete and their sequential children haven't started yet).
        this.#overallCompletionHighWaterMark = Math.max(
            this.#overallCompletionHighWaterMark,
            overallCompletion
        );

        const overallCompletionPct   = Math.round(this.#overallCompletionHighWaterMark * 100);
        const overallStatusMetadata  = this.#getOverallStatusDisplay();

        this.querySelector(".overall-progress-fill").style.width         = `${overallCompletionPct}%`;
        this.querySelector(".overall-progress-percentage").textContent   = `${overallCompletionPct}%`;
        this.querySelector(".overall-progress-status-label").textContent = overallStatusMetadata.label;
        this.querySelector(".overall-progress-status-label").style.color = overallStatusMetadata.color;

        // No tree to draw: say what happens next instead of leaving an empty
        // panel under the bar. This is what most users see.
        if (this.#isSummaryOnly())
        {
            this.querySelector(".task-tree-container").innerHTML =
            `
                <div class="task-tree-summary-note">${GenerationProgressComponent.SUMMARY_PRIMARY_MESSAGE}</div>
                <div class="task-tree-summary-note">${GenerationProgressComponent.SUMMARY_SECONDARY_MESSAGE}</div>
            `;
            return;
        }

        const childrenHtml = (this.#taskTree.children || [])
            .map(childNode => this.#buildTaskNodeHtml(childNode, 0))
            .join("");

        this.querySelector(".task-tree-container").innerHTML = childrenHtml
            || `<div class="task-tree-empty-message">Pipeline starting...</div>`;
    }

    connectedCallback()
    {
        this.innerHTML =
        `

            <div class="overall-progress-card">
                <div class="overall-progress-header">
                    <span class="overall-progress-title">Overall Progress</span>
                    <div class="overall-progress-header-right">
                        <span class="overall-progress-status-label">Queued</span>
                        <span class="overall-progress-percentage">0%</span>
                    </div>
                </div>
                <div class="overall-progress-track">
                    <div class="overall-progress-fill" style="width: 0%;"></div>
                </div>
            </div>

            <div class="task-tree-container">
                <div class="task-tree-empty-message">Waiting for task data...</div>
            </div>
        `;

        if (this.#taskTree)
        {
            this.#render();
        }
    }
}

customElements.define("generation-progress-component", GenerationProgressComponent);
export default GenerationProgressComponent;