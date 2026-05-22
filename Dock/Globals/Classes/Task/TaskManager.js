const { createClient, RESP_TYPES } = require('redis');
const TaskDescriptor = require('./TaskDescriptor');
const BSON = require('bson');
const { taskExecutionTargets } = require('../../Enumerations/TaskExecutionTargets');
const { launchPythonScript } = require('../../UtilityFunctions.js/LaunchPythonScript');
const path = require('path');
const { getPythonExecutablePathFromVenv } = require('../../UtilityFunctions.js/GetPythonExecutablePathFromVenv');
const { taskStatus } = require('../../Enumerations/TaskStatus');
const { taskTypes } = require('../../Enumerations/TaskTypes');
const Logger = require('../Logger');


class TaskManager
{
    static #redisClient = null;
    static #TASK_PREFIX = "Task/";
    static #TASK_TTL_SECONDS = 5 * 60 * 60;
    static #TASK_COMPLETION_SUFFIX = ":completion";
    static #SYNC_LOCK_TTL_SECONDS = 5 * 60;
    static #SYNC_LOCK_PREFIX = "SyncLock/";
    // Per-user index of top-level task ids so the Activity preview can
    // list a user's in-progress tasks without scanning the entire
    // Task/* keyspace. Membership is the truth: rows are added on
    // setTask + trackForUser, removed on untrackForUser (called from
    // the Generate completion handler).
    static #USER_TASKS_PREFIX = "UserActiveTasks/";
    static #registry =
    {
        [TaskDescriptor.TYPE || TaskDescriptor.name]: TaskDescriptor
    };


    static async initialize()
    {
        TaskManager.#redisClient = createClient().withTypeMapping({[RESP_TYPES.BLOB_STRING]: Buffer});
        await TaskManager.#redisClient.connect();

        console.log("TaskManager initialized.");
    }

    /**
     * Returns a task given by its ID.
     * Also merges the atomic completion key written by Python's increment_completion,
     * which is stored separately from the main BSON blob.
     * @param {string} taskId
     * @return {TaskDescriptor}
     */
    static async getTask(taskId)
    {
        const buffer = await TaskManager.#redisClient.get(TaskManager.#TASK_PREFIX + taskId);

        const deserialized = BSON.deserialize(buffer);
        const task = TaskDescriptor.fromJson(deserialized);

        // Python's increment_completion writes progress to a separate atomic key.
        // Read it here and override the BSON completion so the JS side stays in sync.
        const atomicCompletionBuffer = await TaskManager.#redisClient.get(
            TaskManager.#TASK_PREFIX + taskId + TaskManager.#TASK_COMPLETION_SUFFIX
        );

        if (atomicCompletionBuffer !== null)
        {
            // Use the higher of the two values. The BSON blob captures progress
            // from __update_progress() calls, while the atomic key captures
            // accumulated worker increments via increment_completion(). Early in
            // execution the atomic key may be lower than the BSON value — taking
            // the max ensures the bar never goes backwards when workers first start.
            const atomicCompletion = parseFloat(atomicCompletionBuffer.toString());
            task.setCompletion(Math.max(task.getCompletion(), atomicCompletion));
        }

        return task;
    }

    /**
     * Creates a new task entry. No-ops if the key already exists.
     * @param {TaskDescriptor} task
     */
    static async setTask(task)
    {
        const id = task.getId();
        const serialized = BSON.serialize(task.toJson());

        await TaskManager.#redisClient.set(TaskManager.#TASK_PREFIX + id, serialized, { EX: TaskManager.#TASK_TTL_SECONDS, NX: true });
    }

    /**
     * Updates an existing task entry, preserving the remaining TTL.
     * No-ops if the key does not exist.
     * @param {TaskDescriptor} task
     */
    static async updateTask(task)
    {
        const id = task.getId();
        const serialized = BSON.serialize(task.toJson());

        await TaskManager.#redisClient.set(TaskManager.#TASK_PREFIX + id, serialized, { KEEPTTL: true, XX: true });
    }

    /**
     * @param {TaskDescriptor} taskDescriptor
     * @param {number} retries
     * @param {TaskDescriptor|null} mainTask - The root task of the entire pipeline.
     * @param {string|null} parentTaskId - The ID of the task whose nextTaskIds contains this task.
     *                                     Workers use this to call increment_completion on the right parent.
     */
    static async execute(taskDescriptor, retries = 0, mainTask = null, parentTaskId = null)
    {
        let attempt = 0;

        if(mainTask == null)
        {
            mainTask = taskDescriptor;
        }

        while (attempt <= retries)
        {
            try
            {
                switch(taskDescriptor.getExecutionTarget())
                {
                    case taskExecutionTargets.LOCAL:
                    {
                        const taskTypeName = Object.keys(taskTypes).find(key => taskTypes[key] == taskDescriptor.getType());
                        Logger.log(`Executing task locally: ${taskTypeName}`);

                        const agentServicePath = process.env.AGENT_SERVICE_PATH || path.join(__dirname, "../../../..", "Agent");
                        const pythonPath = path.join(getPythonExecutablePathFromVenv(path.join(agentServicePath, ".venv")));
                        const scriptPath = path.join(agentServicePath, "Main.py");

                        const scriptArgs = [
                            `--redis-url=${process.env.REDIS_URL || "redis://127.0.0.1:6379"}`,
                            `--payload=${JSON.stringify(taskDescriptor.getPayload() || {})}`,
                            `--task-id=${taskDescriptor.getId()}`,
                            `--main-task-id=${mainTask.getId()}`,
                            `--parent-task-id=${parentTaskId || mainTask.getId()}`,
                        ];
                        if (Logger.isEnabled()) scriptArgs.push("--debug");

                        const onLine = Logger.isEnabled()
                            ? (stream, line) => Logger.logWorker(taskTypeName, taskDescriptor.getId(), stream, line)
                            : null;

                        await launchPythonScript(pythonPath, scriptPath, scriptArgs, onLine);

                        Logger.log(`Finished execution of task ${taskTypeName}.`);

                        // Re-fetch from Redis — the task may have updated its own nextTaskIds during execution
                        taskDescriptor = await TaskManager.getTask(taskDescriptor.getId());

                        if (taskDescriptor.getStatus() === taskStatus.FAILED)
                        {
                            const error = taskDescriptor.getPayload()?.error ?? 'Task failed with no error message.';
                            throw new Error(error);
                        }

                        break;
                    }
                    case taskExecutionTargets.GOOGLE_CLOUD_RUN:
                    {
                        Logger.log("Executing task on Google Cloud Run.");

                        break;
                    }
                }

                const nextTaskIds = taskDescriptor.getNextTaskIds();
                const nextTasks = await Promise.all(nextTaskIds.map((taskId) => { return TaskManager.getTask(taskId); }));

                // Pass current task's ID as the parent for its children so they can call increment_completion correctly
                const results = await Promise.all(nextTasks.map((task) => { return TaskManager.execute(task, retries, mainTask, taskDescriptor.getId()); }));

                if(results.includes(false))
                {
                    return false;
                }

                return true;
            }
            catch(error)
            {
                console.error(error);

                attempt++;

                if(attempt > retries)
                {
                    return false;
                }

                await new Promise((resolve) => { setTimeout(resolve, 1000 * attempt); });
            }
        }

        return false;
    }

    /**
     * Records ownership of a top-level task in the per-user index so
     * the Activity preview can list in-progress tasks for a user.
     * Idempotent — SADD on the same id is a no-op. The set inherits a
     * fresh TTL matching the task itself so it auto-expires alongside
     * any orphaned task data.
     * @param {string} userId
     * @param {string} taskId
     */
    static async trackForUser(userId, taskId)
    {
        if (!userId || !taskId)
        {
            return;
        }
        const key = TaskManager.#USER_TASKS_PREFIX + userId;
        await TaskManager.#redisClient.sAdd(key, taskId);
        await TaskManager.#redisClient.expire(key, TaskManager.#TASK_TTL_SECONDS);
    }

    /**
     * Removes a task id from the per-user index. Called once the task
     * is recorded into the long-term taskHistory collection, so the
     * Activity preview stops surfacing it as "in progress".
     * @param {string} userId
     * @param {string} taskId
     */
    static async untrackForUser(userId, taskId)
    {
        if (!userId || !taskId)
        {
            return;
        }
        const key = TaskManager.#USER_TASKS_PREFIX + userId;
        await TaskManager.#redisClient.sRem(key, taskId);
    }

    /**
     * Returns the task descriptors of every top-level task currently
     * indexed for `userId`. Stale ids whose underlying Task/{id} blob
     * has expired are silently dropped and lazily removed from the
     * set — this lets the index self-heal after an unclean shutdown
     * without a periodic cleanup job.
     * @param {string} userId
     * @returns {Promise<Array<TaskDescriptor>>}
     */
    static async listActiveForUser(userId)
    {
        if (!userId)
        {
            return [];
        }
        const key = TaskManager.#USER_TASKS_PREFIX + userId;
        const taskIds = await TaskManager.#redisClient.sMembers(key);

        const tasks = [];
        for (const taskId of taskIds)
        {
            try
            {
                const buffer = await TaskManager.#redisClient.get(TaskManager.#TASK_PREFIX + taskId);
                if (buffer === null || buffer === undefined)
                {
                    await TaskManager.#redisClient.sRem(key, taskId);
                    continue;
                }
                const task = await TaskManager.getTask(taskId);
                tasks.push(task);
            }
            catch (readError)
            {
                console.warn(`[TaskManager] listActiveForUser: skipping stale id ${taskId}: ${readError.message}`);
                await TaskManager.#redisClient.sRem(key, taskId);
            }
        }
        return tasks;
    }

    /**
     * Attempts to acquire a sync lock for the given user.
     * Only one device per user can hold the lock at a time.
     * The lock automatically expires after the configured TTL to prevent deadlocks from crashed clients.
     * @param {string} userId - The id of the user to lock syncing for.
     * @param {string} deviceId - The id of the device requesting the lock.
     * @returns {Promise<boolean>} True if the lock was acquired, false if another device holds it.
     */
    static async acquireSyncLock(userId, deviceId)
    {
        const lockKey = TaskManager.#SYNC_LOCK_PREFIX + userId;

        const result = await TaskManager.#redisClient.set(lockKey, deviceId, 
        { 
            NX: true, 
            EX: TaskManager.#SYNC_LOCK_TTL_SECONDS 
        });

        return result !== null;
    }

    /**
     * Releases the sync lock for the given user, but only if the requesting device is the current holder.
     * Uses a Lua script for atomic check-and-delete to prevent race conditions.
     * @param {string} userId - The id of the user whose sync lock should be released.
     * @param {string} deviceId - The id of the device requesting the release.
     * @returns {Promise<boolean>} True if the lock was released, false if the device did not own the lock.
     */
    static async releaseSyncLock(userId, deviceId)
    {
        const lockKey = TaskManager.#SYNC_LOCK_PREFIX + userId;

        const luaScript = `
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            else
                return 0
            end
        `;

        const result = await TaskManager.#redisClient.eval(luaScript, 
        { 
            keys: [lockKey], 
            arguments: [deviceId] 
        });

        return result === 1;
    }

    /**
     * Checks whether a sync lock is currently held for the given user.
     * @param {string} userId - The id of the user to check.
     * @returns {Promise<{bIsLocked: boolean, holderDeviceId: string|null}>} The lock state and the device id holding it.
     */
    static async getSyncLockState(userId)
    {
        const lockKey = TaskManager.#SYNC_LOCK_PREFIX + userId;
        const holderDeviceId = await TaskManager.#redisClient.get(lockKey);

        return {
            bIsLocked: holderDeviceId !== null,
            holderDeviceId: holderDeviceId ? holderDeviceId.toString() : null
        };
    }

    /**
     * Force-releases the sync lock for the user, regardless of which
     * device holds it. Used by the user-triggered "Force sync" affordance
     * when a previous cycle's lock leaked (crashed tab, killed Node
     * before TTL expiry, etc.) and the user is now blocked on their
     * own account.
     * @param {string} userId
     * @returns {Promise<boolean>} True if a lock was found and deleted.
     */
    static async forceReleaseSyncLock(userId)
    {
        const lockKey       = TaskManager.#SYNC_LOCK_PREFIX + userId;
        const deletedCount  = await TaskManager.#redisClient.del(lockKey);
        return deletedCount > 0;
    }
}

module.exports = TaskManager;