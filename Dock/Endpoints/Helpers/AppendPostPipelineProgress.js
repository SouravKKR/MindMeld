const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");

// Low starting completion for the synthetic finalization node. moveToDatabase has
// no real sub-progress to report, so the server emits a small value and the client
// (GenerationProgressComponent) creeps it upward — far better than the old
// hardcoded 0.9, which read as "stuck at 90%".
const FINALIZATION_START_COMPLETION = 0.1;

/**
 * Returns true only when every node in a built subtree has reached a terminal
 * status (COMPLETED or FAILED).
 * @param {object} subtree
 * @returns {boolean}
 */
function isSubtreeTerminal(subtree)
{
    if (!subtree)
    {
        return true;
    }
    if (subtree.status !== taskStatus.COMPLETED && subtree.status !== taskStatus.FAILED)
    {
        return false;
    }
    for (const childSubtree of (subtree.children || []))
    {
        if (!isSubtreeTerminal(childSubtree))
        {
            return false;
        }
    }
    return true;
}

/**
 * Appends a generation's post-pipeline progress to an already-built root tree,
 * in place. Generate's post-pipeline (PrepareImages → EnhanceImages, Beautify,
 * then moveToDatabase) runs OUTSIDE the main task tree; the image/beautify tasks
 * are registered with TaskManager so their real subtrees are fetched and appended,
 * and a synthetic GENERATION_FINALIZATION node covers the marker-only
 * moveToDatabase tail. Shared by /Generate/Progress and /Activity/Tasks/Progress
 * so the live view and the reopened-from-Activity view are identical (previously
 * the Activity endpoint omitted this entirely, so the finalization row vanished
 * on return).
 *
 * @param {object} tree - the built root tree (mutated in place)
 * @param {string} taskId - the root generation task id
 * @param {(id: string) => Promise<object|null>} buildTaskTree - the caller's recursive tree builder
 */
async function appendPostPipelineProgress(tree, taskId, buildTaskTree)
{
    if (!tree || !(await TaskManager.isPostPipelinePending(taskId)))
    {
        return;
    }

    const postPipelineTaskIds = await TaskManager.getPostPipelineTaskIds(taskId);

    let bAllRegisteredTasksTerminal = true;
    for (const postPipelineTaskId of postPipelineTaskIds)
    {
        const subtree = await buildTaskTree(postPipelineTaskId);
        if (subtree === null)
        {
            continue;
        }
        subtree.parentTaskId = taskId;
        tree.children.push(subtree);

        if (!isSubtreeTerminal(subtree))
        {
            bAllRegisteredTasksTerminal = false;
        }
    }

    // Only show the synthetic finalization node when there's no real in-progress
    // post-pipeline work left to display — otherwise it would sit next to a
    // running PREPARE_IMAGES bar. Emitted at a low completion the client creeps.
    if (postPipelineTaskIds.length === 0 || bAllRegisteredTasksTerminal)
    {
        tree.children.push({
            id:           `${taskId}__postpipeline`,
            type:         taskTypes.GENERATION_FINALIZATION,
            status:       taskStatus.IN_PROGRESS,
            completion:   FINALIZATION_START_COMPLETION,
            parentTaskId: taskId,
            error:        null,
            children:     [],
        });
    }
}

module.exports = { appendPostPipelineProgress };
