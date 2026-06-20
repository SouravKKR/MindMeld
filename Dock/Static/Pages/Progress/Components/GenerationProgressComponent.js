import { taskTypes } from "../../../Globals/Enumerations/TaskTypes.js";
import { taskStatus } from "../../../Globals/Enumerations/TaskStatus.js";
import { enumerationToTitleCase } from "../../../Globals/UtilityFunctions/EnumerationToTitleCase.js";

/**
 * GenerationProgressComponent
 *
 * A reusable web component that renders a nested task tree as a live progress display.
 *
 * Usage:
 *   const component = document.createElement("generation-progress-component");
 *   component.update(taskTree);
 *
 * taskTree shape (recursive):
 *   {
 *     id:           string,
 *     type:         number,   // TaskTypes enum value
 *     status:       number,   // TaskStatus enum value
 *     completion:   number,   // 0.0 – 1.0
 *     parentTaskId: string|null,
 *     children:     taskTree[]
 *   }
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
     * Returns the overall pipeline completion (0–1).
     * @returns {number}
     */
    getOverallCompletion()
    {
        if (!this.#taskTree) return 0;
        return this.#computeOverallCompletion(this.#taskTree);
    }

    /**
     * Returns true when every node in the pipeline has reached a terminal state.
     * @returns {boolean}
     */
    isTerminal()
    {
        if (!this.#taskTree) return false;

        const overallStatus = this.#computeOverallStatus(this.#taskTree);
        return overallStatus === taskStatus.COMPLETED || overallStatus === taskStatus.FAILED;
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
     * Computes the overall pipeline completion percentage.
     *
     * Distinct from `#computeEffectiveCompletion` because the overall bar
     * needs to TICK SMOOTHLY across sequential phases (Process Syllabus →
     * Map Topics → Flashcards → …). Per-node display uses the worker-only
     * accumulator so a finished phase stops mis-reporting its successors'
     * progress; the overall bar deliberately keeps the old behavior of
     * averaging across ALL children at every level so the % climbs as
     * each phase finishes.
     *
     * @param {object} taskNode
     * @returns {number}
     */
    #computeRecursiveAverageAcrossAllChildren(taskNode)
    {
        if (Array.isArray(taskNode.children) && taskNode.children.length > 0)
        {
            const childCompletions = taskNode.children.map(childNode =>
                this.#computeRecursiveAverageAcrossAllChildren(childNode)
            );
            return childCompletions.reduce((sum, completion) => sum + completion, 0) / childCompletions.length;
        }
        return taskNode.completion ?? 0;
    }

    #computeOverallCompletion(taskTree)
    {
        if (!taskTree)
        {
            return 0;
        }
        return this.#computeRecursiveAverageAcrossAllChildren(taskTree);
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
        const key = Object.keys(taskTypes).find(taskTypeKey => taskTypes[taskTypeKey] === typeValue);
        return key ? enumerationToTitleCase(key) : `Task ${typeValue}`;
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

        const childrenHtml = (taskNode.children || [])
            .map(childNode => this.#buildTaskNodeHtml(childNode, depth + 1))
            .join("");

        return `
            <div class="task-node ${statusMetadata.pulse ? "task-node-pulsing" : ""}" style="margin-left: ${indentPixels}px;" data-task-id="${taskNode.id}">
                <div class="task-node-header">
                    <div class="task-node-status-dot" style="background: ${statusMetadata.color};"></div>
                    <span class="task-node-label">${label}</span>
                    <span class="task-node-status-label" style="color: ${statusMetadata.color};">${statusMetadata.label}</span>
                    <span class="task-node-completion-percentage">${completionPct}%</span>
                </div>
                <div class="task-node-progress-track">
                    <div class="task-node-progress-fill" style="width: ${completionPct}%; background: ${progressBarColor};"></div>
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

        const overallCompletion      = this.#computeOverallCompletion(this.#taskTree);
        const overallStatus          = this.#computeOverallStatus(this.#taskTree);

        // Advance the high water mark but never retreat it.
        // Transitions between pipeline stages cause brief computed dips
        // (e.g. when tasks complete and their sequential children haven't started yet).
        this.#overallCompletionHighWaterMark = Math.max(
            this.#overallCompletionHighWaterMark,
            overallCompletion
        );

        const overallCompletionPct   = Math.round(this.#overallCompletionHighWaterMark * 100);
        const overallStatusMetadata  = this.#getStatusMetadata(overallStatus);

        this.querySelector(".overall-progress-fill").style.width         = `${overallCompletionPct}%`;
        this.querySelector(".overall-progress-percentage").textContent   = `${overallCompletionPct}%`;
        this.querySelector(".overall-progress-status-label").textContent = overallStatusMetadata.label;
        this.querySelector(".overall-progress-status-label").style.color = overallStatusMetadata.color;

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