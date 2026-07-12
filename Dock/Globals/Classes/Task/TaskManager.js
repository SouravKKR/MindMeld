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
const TaskQueueMode = require('./TaskQueueMode');


class TaskManager
{
    static #redisClient = null;
    static #TASK_PREFIX = "Task/";
    static #TASK_TTL_SECONDS = 5 * 60 * 60;
    static #TASK_COMPLETION_SUFFIX = ":completion";

    // The error reason an Agent task records on its descriptor when the credit
    // gate denies it for lack of balance. Must stay byte-identical to the value
    // written by Agent/Globals/Classes/Task/TaskRunner.py and surfaced by
    // CreditPreflight. Used to detect a mid-pipeline out-of-credits stop.
    static INSUFFICIENT_CREDITS_REASON = "INSUFFICIENT_CREDITS";

    // The payload.error reason stamped on a generation root when the user
    // manually pauses it. Surfaced by GetProgress (tree.paused) and used as the
    // TaskState pausedReason so the resume banner can word itself correctly.
    static USER_PAUSED_REASON = "USER_PAUSED";

    // TaskState pausedReason for a generation orphaned by a Dock restart/crash:
    // a resumable snapshot is saved at generation START and cleared on any
    // outcome the in-process completion handler actually reaches (success or
    // handled failure). If the process died before either ran, this snapshot
    // survives so the home-screen PausedTaskBanner can offer Resume (which
    // re-runs with resumeMainTaskId and skips finished stages via GCS
    // checkpoints). Never a real error stamped on a task payload — TaskState only.
    static INTERRUPTED_REASON = "INTERRUPTED";

    // The payload.error / TaskState pausedReason stamped on a generation root
    // when every text stage succeeded but the post-pipeline image step
    // (PrepareImages → EnhanceImages) failed (e.g. the image service was
    // disabled). Instead of dead-ending the run, the pipeline saves a resumable
    // snapshot under this reason so the user can Resume later — the resumed run
    // reuses the same GCS namespace, skips the already-finished text stages, and
    // re-runs only the image step. Surfaced by GetProgress (tree.imagePreparationFailed)
    // and worded by the PausedTaskBanner. Must stay byte-identical to the string
    // literals the frontend compares against.
    static IMAGE_PREPARATION_FAILED_REASON = "IMAGE_PREPARATION_FAILED";

    // ── Reliable polling queue ──────────────────────────────────────────────
    // Producer side. Dock pushes a small JSON envelope onto the pending list;
    // long-lived Agent workers (Agent/Worker.py) atomically move it to the
    // processing list, run it, and acknowledge. These key names MUST stay
    // identical to the Agent-side TaskManager.py.
    static #TASK_QUEUE_PENDING_KEY = "TaskQueue/pending";
    static #TASK_QUEUE_PROCESSING_KEY = "TaskQueue/processing";
    // Poll cadence + ceiling for awaiting a queued task's terminal status. The
    // timeout is kept safely below the 5h Task/<id> TTL so a blob never expires
    // out from under an in-flight await.
    static #QUEUE_AWAIT_POLL_INTERVAL_MILLISECONDS = TaskManager.#resolvePositiveIntegerSetting("TASK_QUEUE_AWAIT_POLL_MILLISECONDS", 1000);
    static #QUEUE_AWAIT_TIMEOUT_MILLISECONDS = TaskManager.#resolvePositiveIntegerSetting("TASK_QUEUE_AWAIT_TIMEOUT_SECONDS", 3 * 60 * 60) * 1000;
    // Hard ceiling on a single LOCAL Agent subprocess. In local/dev mode (queue
    // disabled) execute() awaits the child's exit with no bound, so a wedged
    // child — e.g. one that hangs on interpreter shutdown after the task was
    // already marked COMPLETED — would block the whole pipeline forever. This
    // kills such a child so the await rejects and the run settles. Generous by
    // default (matches the queue-await ceiling): it is a backstop, not the
    // primary bound — the per-image race in Generate.js is the tight one.
    static #LOCAL_SUBPROCESS_MAX_DURATION_MILLISECONDS = TaskManager.#resolvePositiveIntegerSetting("LOCAL_TASK_MAX_DURATION_SECONDS", 3 * 60 * 60) * 1000;

    /**
     * Reads a strictly-positive integer from the environment, falling back when
     * the value is missing or invalid. Mirrors RateLimiter's env helper.
     *
     * @param {string} environmentVariableName
     * @param {number} fallbackValue
     * @returns {number}
     */
    static #resolvePositiveIntegerSetting(environmentVariableName, fallbackValue)
    {
        const rawValue = process.env[environmentVariableName];

        if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "")
        {
            return fallbackValue;
        }

        const parsedValue = Number(rawValue);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0)
        {
            console.warn(`[TaskManager] Ignoring invalid ${environmentVariableName}="${rawValue}"; using default ${fallbackValue}.`);
            return fallbackValue;
        }

        return Math.floor(parsedValue);
    }
    static #POST_PIPELINE_PREFIX = "PostPipeline/";
    static #POST_PIPELINE_TASKS_PREFIX = "PostPipelineTasks/";
    // Short-lived "the AI provider is busy" signal, keyed by the generation root
    // task id. The Agent refreshes it (Globals/Classes/Automation/ProviderHealthSignal.py)
    // every time a live call or batch poll hits a transient 5xx/429 and backs off.
    // GetProgress reads it so the client can show "provider busy, not halted".
    // This prefix MUST stay byte-identical to the Agent's ProviderHealthSignal.KEY_PREFIX.
    static #PROVIDER_SLOWDOWN_PREFIX = "ProviderSlowdown/";
    // Manual-pause flag, keyed by the generation root task id. Set by the
    // /Generate/Pause endpoint, read by execute() to stop launching new stages.
    // Carries the task TTL so a never-resumed pause flag can't leak forever.
    static #PAUSED_PREFIX = "Paused/";
    static #SYNC_LOCK_TTL_SECONDS = 5 * 60;
    static #SYNC_LOCK_PREFIX = "SyncLock/";
    // Boot-time reconciliation lock. In a future multi-Dock generation
    // deployment this ensures only one booting node settles the orphaned
    // post-pipeline runs. Short TTL so a crashed holder can't block the next
    // boot's sweep. Single-Packetron today, so it is cheap insurance.
    static #RECONCILE_LOCK_KEY = "ReconcileLock/boot";
    static #RECONCILE_LOCK_TTL_SECONDS = 60;
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
     * Returns a task given by its ID, or null if the underlying Redis
     * blob is missing (key never existed OR TTL expired — once a task
     * completes its data lives in the long-term taskHistory collection
     * instead of Redis).
     * Also merges the atomic completion key written by Python's increment_completion,
     * which is stored separately from the main BSON blob.
     * @param {string} taskId
     * @return {Promise<TaskDescriptor|null>}
     */
    /**
     * Walks a live task subtree (from Redis) starting at taskId and returns
     * true if any node stopped because the user ran out of credits — i.e. a
     * FAILED node whose payload.error is INSUFFICIENT_CREDITS_REASON. Used by
     * the Generate pipeline's completion handler to decide whether the run is
     * resumable. Cycles are guarded by a visited set; a missing node is simply
     * skipped (it may have rolled off Redis).
     *
     * @param {string} taskId
     * @param {Set<string>} [visitedTaskIds]
     * @returns {Promise<boolean>}
     */
    static async hasInsufficientCreditsFailure(taskId, visitedTaskIds = new Set())
    {
        if (!taskId || visitedTaskIds.has(taskId))
        {
            return false;
        }
        visitedTaskIds.add(taskId);

        const task = await TaskManager.getTask(taskId);
        if (!task)
        {
            return false;
        }

        if (task.getStatus() === taskStatus.FAILED && (task.getPayload()?.error === TaskManager.INSUFFICIENT_CREDITS_REASON))
        {
            return true;
        }

        for (const childTaskId of (task.getNextTaskIds() || []))
        {
            if (await TaskManager.hasInsufficientCreditsFailure(childTaskId, visitedTaskIds))
            {
                return true;
            }
        }

        return false;
    }

    /**
     * Returns the rolled-up status of a live generation tree for the Activity
     * list: FAILED if ANY node in the tree has failed, otherwise IN_PROGRESS. A
     * task present in the per-user active index is by construction not yet
     * finalized — the Generate completion handler untracks it (and writes the
     * settled taskHistory row) only after the whole pipeline finishes — so the
     * no-op root's own COMPLETED status must never be surfaced as "Completed"
     * while its children are still running (the "shows Completed while it's going
     * on" bug). Missing child blobs are skipped; cycles are guarded by a visited
     * set.
     * @param {string} rootTaskId
     * @param {Set<string>} [visitedTaskIds]
     * @returns {Promise<number>} taskStatus.FAILED or taskStatus.IN_PROGRESS
     */
    static async computeActiveTreeStatus(rootTaskId, visitedTaskIds = new Set())
    {
        if (!rootTaskId || visitedTaskIds.has(rootTaskId))
        {
            return taskStatus.IN_PROGRESS;
        }
        visitedTaskIds.add(rootTaskId);

        const task = await TaskManager.getTask(rootTaskId);
        if (!task)
        {
            return taskStatus.IN_PROGRESS;
        }

        if (task.getStatus() === taskStatus.FAILED)
        {
            return taskStatus.FAILED;
        }

        for (const childTaskId of (task.getNextTaskIds() || []))
        {
            if (await TaskManager.computeActiveTreeStatus(childTaskId, visitedTaskIds) === taskStatus.FAILED)
            {
                return taskStatus.FAILED;
            }
        }

        return taskStatus.IN_PROGRESS;
    }

    static async getTask(taskId)
    {
        // Defensive: callers occasionally pass a Buffer id (Redis sMembers under
        // the blob-string type-mapping returns Buffers). Normalize to a string up
        // front so the id-reconciliation below never stamps a Buffer onto the
        // descriptor's id (which then serializes as {type:"Buffer",…} and breaks
        // every downstream taskid lookup).
        if (Buffer.isBuffer(taskId))
        {
            taskId = taskId.toString("utf8");
        }
        const buffer = await TaskManager.#redisClient.get(TaskManager.#TASK_PREFIX + taskId);

        if (buffer === null || buffer === undefined)
        {
            return null;
        }

        const deserialized = BSON.deserialize(buffer);
        const task = TaskDescriptor.fromJson(deserialized);

        // The Redis key IS the canonical task id. If a deserialized blob ever
        // yields a different id — e.g. TaskDescriptor.fromJson regenerated a
        // random one because the stored `id` was momentarily absent — force it
        // back to the key. Without this, a downstream recordCompletion archives
        // the generation under a phantom id that none of its charges or children
        // reference, which breaks the Activity credit-usage table and any other
        // lookup that joins on the task id.
        if (task.getId() !== taskId)
        {
            task._restoreId_id(taskId);
        }

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
     * Pushes a task onto the pending queue for a worker to claim. The envelope
     * carries the same context the local-subprocess path passes as CLI args
     * (main + parent task ids) so workflows behave identically wherever they run.
     * @param {string} taskId
     * @param {string} mainTaskId
     * @param {string} parentTaskId
     */
    static async enqueueTask(taskId, mainTaskId, parentTaskId)
    {
        // Reset the descriptor to a non-terminal state and clear any leftover
        // atomic-completion value BEFORE enqueuing. Without this, a re-enqueue on
        // retry would carry the previous attempt's COMPLETED/FAILED status, and
        // awaitTerminalStatus could return that stale result before a worker
        // re-claims the task — silently defeating retries.
        const existingTask = await TaskManager.getTask(taskId);
        if (existingTask !== null)
        {
            existingTask.setStatus(taskStatus.NOT_STARTED);
            existingTask.setCompletion(0);
            await TaskManager.updateTask(existingTask);
        }
        await TaskManager.#redisClient.del(TaskManager.#TASK_PREFIX + taskId + TaskManager.#TASK_COMPLETION_SUFFIX);

        const envelope = JSON.stringify({
            taskId: taskId,
            mainTaskId: mainTaskId || taskId,
            parentTaskId: parentTaskId || mainTaskId || taskId
        });

        await TaskManager.#redisClient.lPush(TaskManager.#TASK_QUEUE_PENDING_KEY, envelope);
    }

    /**
     * Polls a queued task until it reaches a terminal status (COMPLETED/FAILED).
     * Returns the final descriptor, or null if the task blob vanished (TTL) or
     * the await timed out — both of which the caller treats as a failure, so the
     * existing retry/false-propagation path in execute() still fires.
     * @param {string} taskId
     * @returns {Promise<TaskDescriptor|null>}
     */
    static async awaitTerminalStatus(taskId)
    {
        const deadline = Date.now() + TaskManager.#QUEUE_AWAIT_TIMEOUT_MILLISECONDS;

        while (Date.now() < deadline)
        {
            const task = await TaskManager.getTask(taskId);

            if (task === null)
            {
                // Blob expired or was never written — treat as failure.
                return null;
            }

            const status = task.getStatus();
            if (status === taskStatus.COMPLETED || status === taskStatus.FAILED)
            {
                return task;
            }

            await new Promise((resolve) => { setTimeout(resolve, TaskManager.#QUEUE_AWAIT_POLL_INTERVAL_MILLISECONDS); });
        }

        console.warn(`[TaskManager] awaitTerminalStatus timed out for task ${taskId}.`);
        return null;
    }

    /**
     * Returns the current queue depth for the autoscaler. `pending` are tasks
     * waiting to be claimed; `processing` are tasks a worker has claimed but not
     * yet acknowledged.
     * @returns {Promise<{pending: number, processing: number}>}
     */
    static async getQueueDepth()
    {
        const pending = await TaskManager.#redisClient.lLen(TaskManager.#TASK_QUEUE_PENDING_KEY);
        const processing = await TaskManager.#redisClient.lLen(TaskManager.#TASK_QUEUE_PROCESSING_KEY);

        return { pending: pending, processing: processing };
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

        // Manual-pause gate. Once the user pauses this generation, every task
        // that hasn't started yet bails here. A task already running (its
        // subprocess / Gemini batch can't be cleanly interrupted) finishes on
        // its own; its not-yet-started children then hit this same gate.
        //
        // We return FALSE so the pause propagates up as pipelineSucceeded ===
        // false. That is exactly what lets the Generate completion handler tell
        // a genuine mid-run pause (some work was skipped → false) apart from a
        // pause clicked a moment after the run already finished (nothing skipped
        // → still true → normal completion, no work discarded).
        if (await TaskManager.isPaused(mainTask.getId()))
        {
            Logger.log(`Pause active for ${mainTask.getId()} — not launching task ${taskDescriptor.getId()}.`);
            return false;
        }

        while (attempt <= retries)
        {
            try
            {
                switch(taskDescriptor.getExecutionTarget())
                {
                    // LOCAL and REMOTE_QUEUE share one branch: the routing decision
                    // is made at runtime by TaskQueueMode, not by the descriptor's
                    // stamped target. In production with the queue enabled, both go
                    // through the distributed worker pool; in --debug / dev, both run
                    // as a local subprocess exactly as before.
                    case taskExecutionTargets.LOCAL:
                    case taskExecutionTargets.REMOTE_QUEUE:
                    {
                        const taskTypeName = Object.keys(taskTypes).find(key => taskTypes[key] == taskDescriptor.getType());

                        if (TaskQueueMode.isQueueEnabled())
                        {
                            Logger.log(`Enqueuing task for the worker pool: ${taskTypeName}`);

                            await TaskManager.enqueueTask(taskDescriptor.getId(), mainTask.getId(), parentTaskId || mainTask.getId());

                            const terminalTask = await TaskManager.awaitTerminalStatus(taskDescriptor.getId());

                            if (terminalTask === null)
                            {
                                throw new Error(`Task ${taskTypeName} did not complete (expired or timed out while queued).`);
                            }

                            Logger.log(`Finished execution of task ${taskTypeName}.`);

                            // Re-assign so the nextTaskIds walk below sees the worker-mutated descriptor.
                            taskDescriptor = terminalTask;

                            if (taskDescriptor.getStatus() === taskStatus.FAILED)
                            {
                                const error = taskDescriptor.getPayload()?.error ?? 'Task failed with no error message.';
                                throw new Error(error);
                            }

                            break;
                        }

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

                        await launchPythonScript(pythonPath, scriptPath, scriptArgs, onLine, TaskManager.#LOCAL_SUBPROCESS_MAX_DURATION_MILLISECONDS);

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
     * Marks the post-pipeline (BeautifyDeckShortNames + PrepareImages +
     * moveToDatabase) as still running for the given top-level Generate
     * task. GetProgress consults this flag and, if set, surfaces a
     * synthetic "finalization" child so the frontend doesn't conclude
     * the user's deck is ready until the database write actually lands.
     *
     * Bracket Generate.js with markPostPipelinePending(...) before
     * starting the main pipeline and markPostPipelineDone(...) in the
     * finally of the .then() chain.
     *
     * @param {string} mainTaskId - The root Generate task id.
     */
    static async markPostPipelinePending(mainTaskId)
    {
        if (!mainTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.set(
            TaskManager.#POST_PIPELINE_PREFIX + mainTaskId,
            "pending",
            { EX: TaskManager.#TASK_TTL_SECONDS }
        );
    }

    /**
     * Clears the post-pipeline marker so subsequent GetProgress polls
     * stop appending the synthetic finalization child and the
     * frontend's #computeOverallStatus() can resolve to COMPLETED.
     * Also clears the registered post-pipeline task ids so a stale
     * list never survives past the marker.
     *
     * @param {string} mainTaskId
     */
    static async markPostPipelineDone(mainTaskId)
    {
        if (!mainTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.del(TaskManager.#POST_PIPELINE_PREFIX + mainTaskId);
        await TaskManager.clearPostPipelineTasks(mainTaskId);
    }

    /**
     * Returns true when a post-pipeline marker is still present —
     * i.e. moveToDatabase hasn't finished yet for this Generate task.
     * Returns false if no marker was ever set OR it was cleared OR
     * its TTL expired.
     *
     * @param {string} mainTaskId
     * @returns {Promise<boolean>}
     */
    static async isPostPipelinePending(mainTaskId)
    {
        if (!mainTaskId)
        {
            return false;
        }
        const value = await TaskManager.#redisClient.get(TaskManager.#POST_PIPELINE_PREFIX + mainTaskId);
        if (value === null || value === undefined)
        {
            return false;
        }
        const asString = typeof value === "string" ? value : value.toString();
        return asString === "pending";
    }

    /**
     * Registers the top-level post-pipeline task ids (e.g. beautify,
     * prepareImages — prepareImages already has enhanceImages chained
     * via its own nextTaskIds, so storing the prepareImages id is
     * enough to surface the entire image subtree to GetProgress).
     *
     * GetProgress reads these ids and recursively walks each subtree,
     * appending the resulting nodes as children of the main task's
     * tree. That replaces the old flat synthetic "Finalizing 50%"
     * placeholder with real per-stage progress so the user can see
     * PREPARE_IMAGES and ENHANCE_IMAGES actually moving.
     *
     * Idempotent — re-registering the same set is a no-op overwrite.
     *
     * @param {string} mainTaskId
     * @param {string[]} taskIds
     */
    static async registerPostPipelineTasks(mainTaskId, taskIds)
    {
        if (!mainTaskId || !Array.isArray(taskIds) || taskIds.length === 0)
        {
            return;
        }
        const cleanedTaskIds = taskIds.filter(taskId => typeof taskId === "string" && taskId.length > 0);
        if (cleanedTaskIds.length === 0)
        {
            return;
        }
        await TaskManager.#redisClient.set(
            TaskManager.#POST_PIPELINE_TASKS_PREFIX + mainTaskId,
            JSON.stringify(cleanedTaskIds),
            { EX: TaskManager.#TASK_TTL_SECONDS }
        );
    }

    /**
     * Returns the registered post-pipeline task ids for the given
     * main task, or an empty array if none were registered or the
     * record expired.
     *
     * @param {string} mainTaskId
     * @returns {Promise<string[]>}
     */
    static async getPostPipelineTaskIds(mainTaskId)
    {
        if (!mainTaskId)
        {
            return [];
        }
        const raw = await TaskManager.#redisClient.get(TaskManager.#POST_PIPELINE_TASKS_PREFIX + mainTaskId);
        if (raw === null || raw === undefined)
        {
            return [];
        }
        const asString = typeof raw === "string" ? raw : raw.toString();
        try
        {
            const parsed = JSON.parse(asString);
            if (!Array.isArray(parsed))
            {
                return [];
            }
            return parsed.filter(taskId => typeof taskId === "string" && taskId.length > 0);
        }
        catch (parseError)
        {
            console.warn(`[TaskManager] getPostPipelineTaskIds: malformed JSON for ${mainTaskId}: ${parseError.message}`);
            return [];
        }
    }

    /**
     * Clears the post-pipeline task id registry for the given main
     * task. Called from markPostPipelineDone so a stale list never
     * survives past the marker.
     *
     * @param {string} mainTaskId
     */
    static async clearPostPipelineTasks(mainTaskId)
    {
        if (!mainTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.del(TaskManager.#POST_PIPELINE_TASKS_PREFIX + mainTaskId);
    }

    /**
     * Scans Redis for every generation root whose post-pipeline marker is still
     * "pending" — the candidate set for boot reconciliation (a run whose
     * in-process Dock driver died before markPostPipelineDone, leaving a phantom
     * "finalization" node forever). Uses a bounded SCAN (never KEYS) so it stays
     * cheap on a large keyspace; it runs once at boot, not on a hot path. The
     * "PostPipeline/*" match cannot collide with the "PostPipelineTasks/" keys
     * (the slash after "PostPipeline" differs), and isPostPipelinePending()
     * re-checks the value, so the result is exactly the pending roots.
     *
     * @returns {Promise<string[]>}
     */
    static async listPendingPostPipelineMainTaskIds()
    {
        const matchPattern = TaskManager.#POST_PIPELINE_PREFIX + "*";
        const pendingMainTaskIds = [];
        // Both the cursor and the keys come back as Buffers under the blob-string
        // type mapping — coerce both to strings so the "0" terminator compares
        // cleanly and each key can be sliced.
        let cursor = "0";

        do
        {
            const scanReply = await TaskManager.#redisClient.scan(cursor, { MATCH: matchPattern, COUNT: 200 });
            cursor = Buffer.isBuffer(scanReply.cursor) ? scanReply.cursor.toString("utf8") : String(scanReply.cursor);

            for (const rawKey of scanReply.keys)
            {
                const key = Buffer.isBuffer(rawKey) ? rawKey.toString("utf8") : String(rawKey);
                const mainTaskId = key.slice(TaskManager.#POST_PIPELINE_PREFIX.length);
                if (mainTaskId && await TaskManager.isPostPipelinePending(mainTaskId))
                {
                    pendingMainTaskIds.push(mainTaskId);
                }
            }
        }
        while (cursor !== "0");

        return pendingMainTaskIds;
    }

    /**
     * Returns true while the AI provider is signalling a transient slowdown for
     * this generation root — i.e. the Agent hit a 5xx/429 and backed off within
     * the last ProviderHealthSignal.SIGNAL_TTL_SECONDS. The key self-expires once
     * the provider recovers, so this naturally returns to false with no cleanup.
     *
     * @param {string} rootTaskId
     * @returns {Promise<boolean>}
     */
    static async isProviderSlowdownActive(rootTaskId)
    {
        if (!rootTaskId)
        {
            return false;
        }
        const exists = await TaskManager.#redisClient.exists(TaskManager.#PROVIDER_SLOWDOWN_PREFIX + rootTaskId);
        return exists === 1;
    }

    /**
     * Marks a generation root as paused so execute() stops launching tasks that
     * haven't started yet. Carries the task TTL so an unresumed flag self-clears.
     * @param {string} rootTaskId
     */
    static async markPaused(rootTaskId)
    {
        if (!rootTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.set(TaskManager.#PAUSED_PREFIX + rootTaskId, "1", { EX: TaskManager.#TASK_TTL_SECONDS });
    }

    /**
     * Returns true while a generation root is flagged paused.
     * @param {string} rootTaskId
     * @returns {Promise<boolean>}
     */
    static async isPaused(rootTaskId)
    {
        if (!rootTaskId)
        {
            return false;
        }
        const exists = await TaskManager.#redisClient.exists(TaskManager.#PAUSED_PREFIX + rootTaskId);
        return exists === 1;
    }

    /**
     * Clears the pause flag for a generation root. Called once the pause has
     * been settled (resumable state saved) so a stale flag can't linger.
     * @param {string} rootTaskId
     */
    static async clearPaused(rootTaskId)
    {
        if (!rootTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.del(TaskManager.#PAUSED_PREFIX + rootTaskId);
    }

    /**
     * Clears the Redis state of a paused generation root so it can be re-run
     * under the SAME id on resume: drops the old (FAILED/USER_PAUSED) task blob
     * and its atomic completion key — so the fresh setTask(NX) lands instead of
     * being shadowed by the stale blob — and clears the pause flag. The durable
     * GCS artifacts under Tasks/{rootTaskId}/ are deliberately left untouched;
     * they are the checkpoint the resumed run reuses.
     * @param {string} rootTaskId
     */
    static async resetForResume(rootTaskId)
    {
        if (!rootTaskId)
        {
            return;
        }
        await TaskManager.#redisClient.del(TaskManager.#TASK_PREFIX + rootTaskId);
        await TaskManager.#redisClient.del(TaskManager.#TASK_PREFIX + rootTaskId + TaskManager.#TASK_COMPLETION_SUFFIX);
        await TaskManager.#redisClient.del(TaskManager.#PAUSED_PREFIX + rootTaskId);
    }

    /**
     * Returns how many milliseconds remain before the live task blob expires from
     * Redis (the 5h window during which the progress tree can still be watched
     * live). Returns null when the key has no expiry or no longer exists.
     *
     * @param {string} taskId
     * @returns {Promise<number|null>}
     */
    static async getRemainingTtlMillis(taskId)
    {
        if (!taskId)
        {
            return null;
        }
        const remainingMillis = await TaskManager.#redisClient.pTTL(TaskManager.#TASK_PREFIX + taskId);
        // redis pTTL returns -2 (no key) or -1 (no expiry) as sentinels.
        if (typeof remainingMillis !== "number" || remainingMillis < 0)
        {
            return null;
        }
        return remainingMillis;
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
        // The client is configured with a Buffer type-mapping for blob strings,
        // so sMembers returns the ids as Buffers. They MUST be coerced back to
        // plain strings: getTask(buffer) reconciles its descriptor id to the key
        // it was given (string !== Buffer), which would stamp a Buffer onto
        // task.getId(). That Buffer then serializes into the Activity entry as
        // {type:"Buffer",data:[…]}, the client opens the progress page with a
        // garbage taskid, and the lookup 404s as "This task is no longer
        // available" — for live/active tasks only (historical ids are Mongo
        // strings). Coercing here keeps every downstream id a real string.
        const taskIds = (await TaskManager.#redisClient.sMembers(key))
            .map((member) => (Buffer.isBuffer(member) ? member.toString("utf8") : member));

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

    /**
     * Acquires the boot-time reconciliation lock so only one node sweeps
     * orphaned post-pipeline runs. Returns true on success. Self-expiring (short
     * TTL) so a crashed holder never blocks the next boot's sweep.
     * @returns {Promise<boolean>}
     */
    static async acquireReconcileLock()
    {
        const result = await TaskManager.#redisClient.set(
            TaskManager.#RECONCILE_LOCK_KEY,
            "1",
            { NX: true, EX: TaskManager.#RECONCILE_LOCK_TTL_SECONDS }
        );
        return result !== null;
    }

    /**
     * Releases the boot-time reconciliation lock. Best-effort — the short TTL
     * also clears it, so a failed release is harmless.
     */
    static async releaseReconcileLock()
    {
        await TaskManager.#redisClient.del(TaskManager.#RECONCILE_LOCK_KEY);
    }
}

module.exports = TaskManager;