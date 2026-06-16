const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskTypes } = require("../../Globals/Enumerations/TaskTypes");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");

/**
 * Recursively fetches a task and all its descendants from Redis,
 * building a nested tree for the client to render.
 * @param {string} taskId
 * @returns {Promise<object|null>}
 */
async function buildTaskTree(taskId)
{
    const task = await TaskManager.getTask(taskId);

    if (!task)
    {
        return null;
    }

    const nextTaskIds = task.getNextTaskIds() || [];

    const children = (await Promise.all(nextTaskIds.map(id => buildTaskTree(id)))).filter(Boolean);

    return {
        id: task.getId(),
        type: task.getType(),
        status: task.getStatus(),
        completion: task.getCompletion(),
        parentTaskId: task.getParentTaskId() || null,
        // Surface the failure reason so the client can distinguish an
        // out-of-credits stop (recoverable — offer top-up / resume) from a
        // generic failure. Null on every non-failed node.
        error: task.getPayload()?.error || null,
        children
    };
}

/**
 * Recursively scans a built progress tree and returns true if any node failed
 * because the user ran out of credits. Lets the client show the out-of-credits
 * resume flow instead of a generic "failed" banner.
 * @param {object|null} treeNode
 * @returns {boolean}
 */
function treeHasInsufficientCredits(treeNode)
{
    if (!treeNode)
    {
        return false;
    }
    if (treeNode.status === taskStatus.FAILED && treeNode.error === TaskManager.INSUFFICIENT_CREDITS_REASON)
    {
        return true;
    }
    for (const childNode of (treeNode.children || []))
    {
        if (treeHasInsufficientCredits(childNode))
        {
            return true;
        }
    }
    return false;
}

async function handleGetProgress(request, response)
{
    const user = await getUser(request);

    if (!user)
    {
        response.sendStatusCode(401);
        return;
    }

    const params = await request.getQueryParams();
    const taskId = params["taskid"];

    if (!taskId)
    {
        response.sendStatusCode(400);
        return;
    }

    const tree = await buildTaskTree(taskId);

    if (!tree)
    {
        response.sendStatusCode(404);
        return;
    }

    // Generate's post-pipeline runs outside the main task tree:
    // beautify (optional) -> prepareImages -> enhanceImages -> moveToDatabase.
    // The real task descriptors for prepareImages and enhanceImages are
    // registered with TaskManager when Generate dispatches them, so we
    // can fetch the actual subtrees and append them here. That gives
    // the frontend real per-stage progress instead of a flat
    // placeholder stuck at 50%.
    //
    // The marker (isPostPipelinePending) covers moveToDatabase too,
    // which is a plain JS function with no TaskDescriptor. While the
    // real subtrees still show in-progress, the marker is what
    // prevents the frontend from flipping to "complete" prematurely.
    // Once every real subtree reaches a terminal state but the marker
    // is still set (i.e., moveToDatabase is the current phase), we
    // append a synthetic GENERATION_FINALIZATION node so
    // #computeOverallStatus() keeps waiting.
    if (await TaskManager.isPostPipelinePending(taskId))
    {
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

        // Only show the synthetic finalization node when there's no
        // real in-progress work left to display — otherwise it would
        // sit next to a running PREPARE_IMAGES bar and confuse the
        // user. When we DO show it, mark it IN_PROGRESS with a high
        // completion so the bar visually creeps forward instead of
        // anchoring at a misleading 50%.
        if (postPipelineTaskIds.length === 0 || bAllRegisteredTasksTerminal)
        {
            tree.children.push({
                id:           `${taskId}__postpipeline`,
                type:         taskTypes.GENERATION_FINALIZATION,
                status:       taskStatus.IN_PROGRESS,
                completion:   0.9,
                parentTaskId: taskId,
                children:     []
            });
        }
    }

    // Flag a mid-pipeline out-of-credits stop so the client can offer the
    // top-up / resume flow rather than a dead-end failure. Computed after the
    // post-pipeline subtrees are appended so a credit stop there counts too.
    tree.outOfCredits = treeHasInsufficientCredits(tree);

    response.sendJson(tree);
}

/**
 * Walks a task subtree and returns true only when every node has
 * reached a terminal status (COMPLETED or FAILED). Used to decide
 * whether the GENERATION_FINALIZATION synthetic node should be
 * surfaced — see the call site for the rationale.
 *
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
    const children = subtree.children || [];
    for (const childSubtree of children)
    {
        if (!isSubtreeTerminal(childSubtree))
        {
            return false;
        }
    }
    return true;
}

module.exports = { handleGetProgress };