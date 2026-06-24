const TaskManager = require("../../Globals/Classes/Task/TaskManager");
const { taskStatus } = require("../../Globals/Enumerations/TaskStatus");

/**
 * Inspects a finished generation pipeline's task tree to classify each
 * requested output scope (flashcards / study materials / mock tests) as
 * having completed cleanly or failed somewhere in its subtree.
 *
 * Failure detection is tree-based rather than reading a scope task's own
 * status. A scope task (e.g. GENERATE_FLASHCARDS) marks itself COMPLETED the
 * moment its run() returns — even when one of the fan-out workers it gathered
 * raised and wrote no cards for that group. The worker task, however, is
 * always written FAILED in Redis by its own TaskRunner. Walking the whole
 * scope subtree for any FAILED node is therefore the only reliable signal; it
 * mirrors how the frontend GenerationProgressComponent rolls a failed worker
 * up into its parent's effective status.
 */
class GenerationOutcomeInspector
{
    static async #buildTree(taskId)
    {
        const task = await TaskManager.getTask(taskId);
        if (!task)
        {
            return null;
        }

        const nextTaskIds = task.getNextTaskIds() || [];
        const children = (await Promise.all(nextTaskIds.map(childId => GenerationOutcomeInspector.#buildTree(childId)))).filter(Boolean);

        return { id: task.getId(), status: task.getStatus(), children: children };
    }

    static #findNode(node, targetId)
    {
        if (!node)
        {
            return null;
        }
        if (node.id === targetId)
        {
            return node;
        }
        for (const childNode of node.children)
        {
            const found = GenerationOutcomeInspector.#findNode(childNode, targetId);
            if (found)
            {
                return found;
            }
        }
        return null;
    }

    /**
     * A scope counts as fully completed only when its node AND every descendant
     * reached COMPLETED. Any non-completed node (FAILED, or never-materialised)
     * makes the scope a retry candidate.
     */
    static #subtreeFullyCompleted(node)
    {
        if (!node)
        {
            return false;
        }
        if (node.status !== taskStatus.COMPLETED)
        {
            return false;
        }
        for (const childNode of node.children)
        {
            if (!GenerationOutcomeInspector.#subtreeFullyCompleted(childNode))
            {
                return false;
            }
        }
        return true;
    }

    /**
     * @param {string} mainTaskId
     * @param {{ [scopeKey: string]: (string|null) }} scopeTaskIdsByKey
     *        Maps each requested output scope body-key
     *        ("flashcardGeneration" | "studyMaterialGeneration" |
     *        "mockTestGeneration") to its scope task id, or null when that
     *        scope was not requested.
     * @returns {Promise<{ completedScopes: string[], failedScopes: string[] }>}
     */
    static async inspect(mainTaskId, scopeTaskIdsByKey)
    {
        const tree = await GenerationOutcomeInspector.#buildTree(mainTaskId);

        const completedScopes = [];
        const failedScopes = [];

        for (const [scopeKey, scopeTaskId] of Object.entries(scopeTaskIdsByKey))
        {
            if (!scopeTaskId)
            {
                continue;
            }

            const scopeNode = GenerationOutcomeInspector.#findNode(tree, scopeTaskId);

            if (GenerationOutcomeInspector.#subtreeFullyCompleted(scopeNode))
            {
                completedScopes.push(scopeKey);
            }
            else
            {
                failedScopes.push(scopeKey);
            }
        }

        return { completedScopes: completedScopes, failedScopes: failedScopes };
    }
}

module.exports = GenerationOutcomeInspector;
