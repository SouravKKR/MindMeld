const { getUser } = require("../Helpers/GetUser");
const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");
const {httpStatus} = require("../../Globals/Enumerations/HttpStatus");
const { appendPostPipelineProgress } = require("../Helpers/AppendPostPipelineProgress");
const ProgressVisibilityFilter = require("../../Globals/Classes/Task/ProgressVisibilityFilter");

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
        response.sendStatusCode(httpStatus.UNAUTHORIZED);
        return;
    }

    const params = await request.getQueryParams();
    const taskId = params["taskid"];

    if (!taskId)
    {
        response.sendStatusCode(httpStatus.BAD_REQUEST);
        return;
    }

    // Fetched once, up front: the ownership gate below, the partialCompletion
    // marker, and the paused / image-failure flags all read the same root task.
    const rootTask = await TaskManager.getTask(taskId);

    if (!rootTask)
    {
        response.sendStatusCode(httpStatus.NOT_FOUND);
        return;
    }

    // Ownership. This endpoint used to check only that SOMEBODY was logged in,
    // so any signed-in user who knew (or guessed) a task id was handed another
    // user's pipeline — including the deck ids and failure reasons on it. The
    // sibling /Activity/Tasks/Progress and /Generate/Pause both already gate on
    // the task's own userId; this now matches them. Administrators are exempt so
    // they can still diagnose a stuck run from a reported task id.
    const ownerUserId = (typeof rootTask.getUserId === "function") ? (rootTask.getUserId() || "") : "";
    if (ownerUserId !== user.getId() && !ProgressVisibilityFilter.isAdministrator(user))
    {
        response.sendStatusCode(httpStatus.FORBIDDEN);
        return;
    }

    const tree = await buildTaskTree(taskId);

    if (!tree)
    {
        response.sendStatusCode(httpStatus.NOT_FOUND);
        return;
    }

    // Append the post-pipeline progress (PrepareImages/EnhanceImages/Beautify
    // subtrees + the synthetic GENERATION_FINALIZATION node for moveToDatabase).
    // Shared with /Activity/Tasks/Progress so both views are identical.
    await appendPostPipelineProgress(tree, taskId, buildTaskTree);

    // Flag a mid-pipeline out-of-credits stop so the client can offer the
    // top-up / resume flow rather than a dead-end failure. Computed after the
    // post-pipeline subtrees are appended so a credit stop there counts too.
    tree.outOfCredits = treeHasInsufficientCredits(tree);

    // Surface the partialCompletion marker (written by Generate's pipeline
    // settler when one output type failed but others were kept) so the client
    // can offer "kept N, retry the rest" instead of a bare "Failed". Lives on
    // the root task's payload; null on every normal run.
    tree.partialCompletion = (rootTask && rootTask.getPayload && rootTask.getPayload()) ? (rootTask.getPayload().partialCompletion || null) : null;

    // Flag a user-initiated pause so the client shows a "paused — resume later"
    // terminal state (recoverable) instead of a dead-end "failed". The root is
    // stamped FAILED + USER_PAUSED by the Generate pipeline's pause handler.
    tree.paused = !!(rootTask && rootTask.getPayload && rootTask.getPayload() && rootTask.getPayload().error === TaskManager.USER_PAUSED_REASON);

    // Flag a post-pipeline image-step failure (text succeeded, PrepareImages /
    // EnhanceImages failed). Also recoverable: the run is held un-persisted with a
    // resumable snapshot, so the client shows a "text ready — resume to finish the
    // images" prompt instead of a dead-end "failed". The root is stamped FAILED +
    // IMAGE_PREPARATION_FAILED by the Generate pipeline's image-failure handler.
    tree.imagePreparationFailed = !!(rootTask && rootTask.getPayload && rootTask.getPayload() && rootTask.getPayload().error === TaskManager.IMAGE_PREPARATION_FAILED_REASON);

    // Surface a transient "AI provider is busy" signal so the client can show a
    // non-alarming banner ("slower than usual but still running") instead of the
    // user reading a long-flat bar as a hang. Self-expiring key — false once the
    // provider recovers.
    tree.providerSlowdown = await TaskManager.isProviderSlowdownActive(taskId);

    // Surface how long the live tree stays viewable (Redis 5h TTL) so the client
    // can tell the user how long they can close the page and still resume to watch.
    tree.remainingTtlMillis = await TaskManager.getRemainingTtlMillis(taskId);

    // Stamp the server-computed overall roll-up for everyone, and strip the
    // per-task tree for everyone who is not an administrator. Runs last: every
    // flag above is derived from the children this may remove.
    ProgressVisibilityFilter.apply(tree, user);

    response.sendJson(tree);
}

module.exports = { handleGetProgress };