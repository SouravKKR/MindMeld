import os
import sys
import json
import redis.asyncio as redis
import bson
from Globals.Classes.Task.TaskDescriptor import TaskDescriptor
from Globals.Enumerations.TaskStatus import TaskStatus
from Globals.Enumerations.TaskExecutionTargets import TaskExecutionTargets


class TaskManager:

    __redis_client = None
    __current_task: TaskDescriptor = None
    __TASK_PREFIX = "Task/"
    __TASK_TTL_SECONDS = 5 * 60 * 60
    __TASK_COMPLETION_SUFFIX = ":completion"

    # Reliable-queue keys — these MUST stay byte-for-byte identical to the Dock
    # side (Dock/Globals/Classes/Task/TaskManager.js) because Dock is the producer
    # (enqueueTask) and the Agent workers are the consumers. Pending holds work
    # waiting to be claimed; processing holds work a worker has taken but not yet
    # acknowledged; a per-task lease key proves the owning worker is still alive so
    # the reaper can requeue work orphaned by a crashed worker.
    __TASK_QUEUE_PENDING_KEY = "TaskQueue/pending"
    __TASK_QUEUE_PROCESSING_KEY = "TaskQueue/processing"
    __TASK_LEASE_PREFIX = "TaskLease/"


    @staticmethod
    async def initialize_connection_only():
        """
        Connects the shared Redis client WITHOUT binding a current task. Used by
        the long-lived worker (Agent/Worker.py), which claims many different tasks
        over its lifetime and sets the current task per iteration via
        set_current_task — there is no single ambient TASK_ID for a worker process.
        """
        TaskManager.__redis_client = redis.from_url(os.getenv("REDIS_URL", "redis://127.0.0.1:6379"), decode_responses=False)

        await TaskManager.__redis_client.ping()

        print("TaskManager connection initialized.")


    @staticmethod
    async def initialize():
        """
        One-shot initialization used by Agent/Main.py: connects and binds the
        ambient task identified by the TASK_ID environment variable.
        """
        await TaskManager.initialize_connection_only()

        TaskManager.__current_task = await TaskManager.get_task(os.getenv("TASK_ID"))

        print("TaskManager initialized.")


    @staticmethod
    async def get_current_task() -> TaskDescriptor:
        return TaskManager.__current_task


    @staticmethod
    def set_current_task(task: TaskDescriptor):
        """
        Binds the descriptor the worker is about to run as the ambient current
        task so workflows that call get_current_task() behave identically to the
        one-shot Main.py path.
        """
        TaskManager.__current_task = task


    @staticmethod
    def get_redis_client():
        """
        Returns the shared async Redis client used by the Agent process.
        Other components (e.g. the cross-process Gemini rate limiter) reuse
        this single connection instead of opening their own — Redis caps
        max-connections-per-client low by default and double-opening for
        every helper class would burn that budget fast.
        """
        return TaskManager.__redis_client


    @staticmethod
    async def get_task(task_id: str) -> TaskDescriptor:
        buffer = await TaskManager.__redis_client.get(TaskManager.__TASK_PREFIX + task_id)

        if buffer is None:
            return None

        deserialized = bson.decode(buffer)
        task = TaskDescriptor.from_json(deserialized)

        # The Redis key IS the canonical task id. If a deserialized blob ever
        # yields a different id (e.g. from_json regenerated a random one because
        # the stored id was momentarily absent), force it back to the key so the
        # id every downstream join relies on (charges, history, children) stays
        # consistent.
        if task.get_id() != task_id:
            task._restore_id_id(task_id)

        # Merge atomic completion value if a separate key exists.
        # Take the max of the BSON value and the atomic key — the BSON captures
        # __update_progress() calls while the atomic key captures increment_completion()
        # from workers. Early in worker execution the atomic key may be lower.
        completion_value = await TaskManager.__redis_client.get(TaskManager.__TASK_PREFIX + task_id + TaskManager.__TASK_COMPLETION_SUFFIX)
        if completion_value is not None:
            task.set_completion(max(task.get_completion(), float(completion_value)))

        return task


    @staticmethod
    async def set_task(task: TaskDescriptor, atomic: bool = False):
        task_id = task.get_id()
        serialized = bson.encode(task.to_json())
        task_key = TaskManager.__TASK_PREFIX + task_id

        if atomic:
            lua_script = """
                local ttl = redis.call('TTL', KEYS[1])
                if ttl < 0 then ttl = tonumber(ARGV[2]) end
                redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
                return ttl
            """
            await TaskManager.__redis_client.eval(lua_script, 1, task_key, serialized, TaskManager.__TASK_TTL_SECONDS)
        else:
            created = await TaskManager.__redis_client.set(task_key, serialized, ex=TaskManager.__TASK_TTL_SECONDS, nx=True)

            if not created:
                await TaskManager.__redis_client.set(task_key, serialized, keepttl=True, xx=True)


    @staticmethod
    async def increment_completion(task_id: str, delta: float) -> float:
        """
        Atomically increments the completion of a task by delta.
        When completion reaches or exceeds 1.0, marks the task as COMPLETED.
        Defensively clamps stored value to [0.0, 1.0] so a buggy delta upstream
        cannot produce nonsensical UI percentages (e.g. 6900%).
        """
        completion_key = TaskManager.__TASK_PREFIX + task_id + TaskManager.__TASK_COMPLETION_SUFFIX

        new_value = float(await TaskManager.__redis_client.incrbyfloat(completion_key, delta))

        if new_value > 1.0:
            await TaskManager.__redis_client.set(completion_key, "1.0", keepttl=True)
            new_value = 1.0
        elif new_value < 0.0:
            await TaskManager.__redis_client.set(completion_key, "0.0", keepttl=True)
            new_value = 0.0

        await TaskManager.__redis_client.expire(completion_key, TaskManager.__TASK_TTL_SECONDS)

        if new_value >= 1.0:
            task = await TaskManager.get_task(task_id)
            if task is not None:
                task.set_status(TaskStatus.COMPLETED)
                task.set_completion(1.0)
                await TaskManager.set_task(task, atomic=True)

        return new_value


    # ── Reliable polling queue (worker side) ────────────────────────────────
    # Dock pushes a small JSON envelope { taskId, mainTaskId, parentTaskId } onto
    # the pending list. A worker atomically moves one envelope to the processing
    # list (BLMOVE RIGHT->LEFT == reliable BRPOPLPUSH, FIFO since Dock LPUSHes to
    # the head), runs it, then acknowledges. The reaper requeues any processing
    # envelope whose lease has expired (the owning worker died).

    # Atomic claim: pop the oldest pending envelope into processing AND set its
    # liveness lease in a single Redis round-trip, so there is NO window in which
    # a claimed task sits in the processing list without a lease (which the reaper
    # would otherwise mistake for an orphaned task and requeue, causing double
    # execution). cjson parses the envelope to extract the task id for the lease
    # key. Non-blocking (RPOPLPUSH, not BRPOPLPUSH) — the worker polls, which is
    # consistent with the rest of the framework's polling design.
    __CLAIM_LUA_SCRIPT = """
        local entry = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
        if not entry then return false end
        local ok, decoded = pcall(cjson.decode, entry)
        if ok and decoded and decoded.taskId then
            redis.call('SET', ARGV[1] .. decoded.taskId, '1', 'EX', tonumber(ARGV[2]))
        end
        return entry
    """

    @staticmethod
    async def claim_next_task_id(lease_seconds: int):
        """
        Atomically claims the oldest pending envelope (moving it to processing and
        writing its lease in one step) and returns it as a decoded JSON string, or
        None if the queue is empty.
        """
        envelope = await TaskManager.__redis_client.eval(
            TaskManager.__CLAIM_LUA_SCRIPT,
            2,
            TaskManager.__TASK_QUEUE_PENDING_KEY,
            TaskManager.__TASK_QUEUE_PROCESSING_KEY,
            TaskManager.__TASK_LEASE_PREFIX,
            str(lease_seconds),
        )

        if envelope is None or envelope is False:
            return None

        return envelope.decode("utf-8") if isinstance(envelope, (bytes, bytearray)) else str(envelope)


    @staticmethod
    async def set_task_lease(task_id: str, lease_seconds: int):
        """Writes/refreshes the liveness lease for a claimed task."""
        await TaskManager.__redis_client.set(
            TaskManager.__TASK_LEASE_PREFIX + task_id,
            b"1",
            ex=lease_seconds,
        )


    @staticmethod
    async def acknowledge_task(task_envelope: str, task_id: str):
        """
        Removes the claimed envelope from the processing list and drops its lease.
        Called whether the task succeeded or failed — failure is recorded on the
        task descriptor itself, so a finished-but-failed task must still leave the
        processing list (otherwise the reaper would requeue it forever).
        """
        await TaskManager.__redis_client.lrem(TaskManager.__TASK_QUEUE_PROCESSING_KEY, 1, task_envelope.encode("utf-8"))
        await TaskManager.__redis_client.delete(TaskManager.__TASK_LEASE_PREFIX + task_id)


    @staticmethod
    async def requeue_stale_tasks() -> int:
        """
        Requeues every processing envelope whose lease key has expired — i.e. the
        worker that claimed it died before acknowledging. Idempotent and safe to
        run from every worker concurrently: the LREM count guard ensures only the
        worker that actually removed the envelope re-pushes it. Returns the number
        of envelopes requeued.
        """
        requeued_count = 0

        processing_entries = await TaskManager.__redis_client.lrange(TaskManager.__TASK_QUEUE_PROCESSING_KEY, 0, -1)

        for entry in processing_entries:
            entry_string = entry.decode("utf-8") if isinstance(entry, (bytes, bytearray)) else str(entry)

            try:
                envelope = json.loads(entry_string)
                task_id = envelope.get("taskId", "")
            except (ValueError, AttributeError):
                # Malformed entry — remove it so it cannot wedge the reaper.
                await TaskManager.__redis_client.lrem(TaskManager.__TASK_QUEUE_PROCESSING_KEY, 1, entry)
                continue

            if not task_id:
                await TaskManager.__redis_client.lrem(TaskManager.__TASK_QUEUE_PROCESSING_KEY, 1, entry)
                continue

            lease_exists = await TaskManager.__redis_client.exists(TaskManager.__TASK_LEASE_PREFIX + task_id)
            if lease_exists:
                continue

            removed = await TaskManager.__redis_client.lrem(TaskManager.__TASK_QUEUE_PROCESSING_KEY, 1, entry)
            if removed and removed > 0:
                # Push to the TAIL (rpush): claims pop from the tail (RPOPLPUSH),
                # so a requeued orphan returns to the oldest position and is
                # re-claimed promptly rather than behind all newer pending work.
                await TaskManager.__redis_client.rpush(TaskManager.__TASK_QUEUE_PENDING_KEY, entry)
                requeued_count += 1

        return requeued_count


    @staticmethod
    async def execute(task_descriptor: TaskDescriptor, main_task: TaskDescriptor = None, parent_task_id: str = None, total_weight: float = 0.0, wait: bool = True) -> dict | None:
        from Globals.Utility.LaunchPythonScript import launch_python_script

        match task_descriptor.get_execution_target():
            # A worker that claimed a top-level REMOTE_QUEUE task runs its nested
            # children right here on the same machine via a local subprocess —
            # the queue only distributes top-level DAG tasks, not a workflow's own
            # internal parallelism. So REMOTE_QUEUE is handled identically to LOCAL.
            case TaskExecutionTargets.LOCAL | TaskExecutionTargets.REMOTE_QUEUE:
                if main_task is None:
                    main_task = task_descriptor

                agent_service_path = os.getenv("AGENT_SERVICE_PATH") or os.path.join(os.path.dirname(__file__), "..", "..", "..", "..", "Agent")
                agent_service_path = os.path.normpath(agent_service_path)
                
                python_path = sys.executable
                script_path = os.path.join(agent_service_path, "Main.py")
                print(script_path)
                
                args = [
                    f"--redis-url={os.getenv('REDIS_URL', 'redis://127.0.0.1:6379')}",
                    f"--task-id={task_descriptor.get_id()}",
                    f"--main-task-id={main_task.get_id()}",
                    f"--parent-task-id={parent_task_id or main_task.get_id()}",
                    f"--total-weight={total_weight}",
                ]

                if "--debug" in sys.argv:
                    args.append("--debug")

                result = await launch_python_script(python_path, script_path, args, wait=wait)

                if result:
                    print(result["stdout"])
                    print(result["stderr"])

                return result
            
            case TaskExecutionTargets.GOOGLE_CLOUD_RUN:
                raise NotImplementedError