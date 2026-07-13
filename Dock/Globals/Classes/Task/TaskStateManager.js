const DatabaseConstants = require("../../Constants/DatabaseConstants");
const DatabaseConnector = require("../Database/DatabaseConnector");
const Persistence = require("../Persistence");
const { storageTargets } = require("../../Enumerations/StorageTargets");
const TaskState = require("../../Model/TaskState");

// Owns the lifecycle of a user's single resumable TaskState.
//
// The full state content is stored in the GCS bucket under
// TaskStates/{userId}/ (so large payloads / resources never bloat Mongo); a
// lean index document in the taskStates collection is the lifecycle owner:
//   - its unique userId index enforces AT MOST ONE state per user, so this
//     can never be abused as general-purpose storage, and
//   - its TTL index on expiresAt auto-deletes a stale state after a week.
// The bucket prefix is per-user and cleaned on every save / delete, so the
// bucket footprint is bounded to one state per user too.

class TaskStateManager
{
    static #BUCKET_DIRECTORY = "TaskStates";
    static #STATE_OBJECT_NAME = "state.json";

    static #bucketPrefixForUser(userId)
    {
        return `${TaskStateManager.#BUCKET_DIRECTORY}/${userId}`;
    }

    static #statePathForUser(userId)
    {
        return `${TaskStateManager.#bucketPrefixForUser(userId)}/${TaskStateManager.#STATE_OBJECT_NAME}`;
    }

    static async #getCollection()
    {
        return (await DatabaseConnector.getDatabase()).collection(DatabaseConstants.TASK_STATES_COLLECTION);
    }

    /**
     * Persists (or overwrites) the user's single resumable task state.
     * @param {{ userId: string, taskType: number, route: string, payload: object, pausedReason?: string, resourceBlobs?: Array<{ name: string, data: (string|Buffer|Uint8Array) }> }} options
     * @returns {Promise<TaskState|null>}
     */
    static async save({ userId, taskType, route, payload, pausedReason = "", resourceBlobs = [] })
    {
        if (!userId)
        {
            return null;
        }

        // One state per user — clear any prior bucket content first.
        await TaskStateManager.#cleanBucket(userId);

        const bucketPrefix = TaskStateManager.#bucketPrefixForUser(userId);
        const resourcePaths = [];

        for (const blob of (Array.isArray(resourceBlobs) ? resourceBlobs : []))
        {
            if (!blob || !blob.name)
            {
                continue;
            }
            const objectPath = `${bucketPrefix}/resources/${blob.name}`;
            await Persistence.write(objectPath, blob.data, storageTargets.LINODE_OBJECT_STORAGE);
            resourcePaths.push(objectPath);
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + DatabaseConstants.TASK_STATES_TTL_DAYS * 24 * 60 * 60 * 1000);

        const taskState = new TaskState({
            userId: userId,
            taskType: taskType,
            route: route,
            payload: payload || {},
            pausedReason: pausedReason,
            resourcePaths: resourcePaths,
            createdAt: now,
            expiresAt: expiresAt,
        });

        const statePath = TaskStateManager.#statePathForUser(userId);
        await Persistence.write(statePath, JSON.stringify(taskState.toJson()), storageTargets.LINODE_OBJECT_STORAGE);

        const collection = await TaskStateManager.#getCollection();
        await collection.replaceOne
        (
            { userId: userId },
            {
                userId: userId,
                taskType: taskState.getTaskType(),
                route: taskState.getRoute(),
                pausedReason: pausedReason,
                statePath: statePath,
                resourcePaths: resourcePaths,
                createdAt: now,
                expiresAt: expiresAt,
            },
            { upsert: true }
        );

        return taskState;
    }

    /**
     * Returns the user's resumable task state, or null if none exists.
     * @param {string} userId
     * @returns {Promise<TaskState|null>}
     */
    static async load(userId)
    {
        if (!userId)
        {
            return null;
        }

        const collection = await TaskStateManager.#getCollection();
        const indexDocument = await collection.findOne({ userId: userId });
        if (!indexDocument)
        {
            return null;
        }

        try
        {
            const content = await Persistence.read(indexDocument.statePath, storageTargets.LINODE_OBJECT_STORAGE);
            const stateJson = JSON.parse(content.toString());
            return TaskState.fromJson(stateJson);
        }
        catch (readError)
        {
            // The bucket blob is missing or corrupt — drop the stale index doc
            // so the user isn't stuck pointing at an unreadable state.
            console.warn(`[TaskStateManager] state blob unreadable for ${userId}: ${readError.message}`);
            await TaskStateManager.delete(userId);
            return null;
        }
    }

    /**
     * Cheap existence check (no bucket read).
     * @param {string} userId
     * @returns {Promise<boolean>}
     */
    static async exists(userId)
    {
        if (!userId)
        {
            return false;
        }
        const collection = await TaskStateManager.#getCollection();
        const count = await collection.countDocuments({ userId: userId }, { limit: 1 });
        return count > 0;
    }

    /**
     * Deletes the user's task state (bucket content + index doc). Idempotent.
     * @param {string} userId
     */
    static async delete(userId)
    {
        if (!userId)
        {
            return;
        }
        await TaskStateManager.#cleanBucket(userId);
        const collection = await TaskStateManager.#getCollection();
        await collection.deleteOne({ userId: userId });
    }

    static async #cleanBucket(userId)
    {
        try
        {
            // Trailing slash so the prefix matches ONLY this user's objects —
            // never a sibling whose id happens to start with this userId.
            const prefix = `${TaskStateManager.#bucketPrefixForUser(userId)}/`;
            const objectPaths = await Persistence.list(prefix, storageTargets.LINODE_OBJECT_STORAGE);
            for (const objectPath of objectPaths)
            {
                await Persistence.delete(objectPath, storageTargets.LINODE_OBJECT_STORAGE);
            }
        }
        catch (cleanError)
        {
            console.warn(`[TaskStateManager] bucket cleanup failed for ${userId}: ${cleanError?.message || cleanError}`);
        }
    }
}

module.exports = TaskStateManager;
